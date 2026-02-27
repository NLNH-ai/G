const SLOT_ORDER = ['left', 'center', 'right'];
const SLOT_LABELS = {
  left: '왼쪽 좌석 비어있음',
  center: '중앙 좌석 비어있음',
  right: '오른쪽 좌석 비어있음',
};
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
const MAX_LOG = 8;
const FORCE_SIMPLE_CAMERA_MODE = true;
const MIN_LOCAL_VIEW_ZOOM = 1;
const MAX_LOCAL_VIEW_ZOOM = 2.2;
const LOCAL_VIEW_ZOOM_STEP = 0.2;
const AVATAR_PALETTES = [
  {
    fur: '#eceef3',
    furShadow: '#cfd6e3',
    innerEar: '#f7bfce',
    eye: '#293046',
    blush: '#f8aac2',
    paw: '#3b3944',
    pawPad: '#f4b0c8',
    hoodie: '#bcc5da',
    hoodieShadow: '#9eadcb',
    accent: '#f4d16b',
  },
  {
    fur: '#efeff4',
    furShadow: '#d3d9e4',
    innerEar: '#f4c6d4',
    eye: '#2a2f45',
    blush: '#f7b8cd',
    paw: '#4a3f53',
    pawPad: '#f2b4ca',
    hoodie: '#7d9ddd',
    hoodieShadow: '#637dba',
    accent: '#ffd077',
  },
  {
    fur: '#f5f1ec',
    furShadow: '#ddd1c6',
    innerEar: '#f5c4cc',
    eye: '#3a3445',
    blush: '#f2aab8',
    paw: '#5a4b4a',
    pawPad: '#f5b8bf',
    hoodie: '#9bb8b3',
    hoodieShadow: '#7f9f98',
    accent: '#f5cf71',
  },
  {
    fur: '#ecedf5',
    furShadow: '#cfd2e4',
    innerEar: '#efc1de',
    eye: '#2d3149',
    blush: '#efabc9',
    paw: '#3f3a56',
    pawPad: '#f0b5d3',
    hoodie: '#9a91d3',
    hoodieShadow: '#7f75bc',
    accent: '#f6d27a',
  },
  {
    fur: '#f1f0f6',
    furShadow: '#d8d5e5',
    innerEar: '#f6c4d3',
    eye: '#2c3452',
    blush: '#f5b5c2',
    paw: '#4b4658',
    pawPad: '#f4b7c8',
    hoodie: '#89b2cf',
    hoodieShadow: '#6f97b5',
    accent: '#f8d57d',
  },
];

const elements = {
  audioBtn: document.getElementById('audio-btn'),
  capacityText: document.getElementById('capacity-text'),
  connectionStatus: document.getElementById('connection-status'),
  eventLog: document.getElementById('event-log'),
  focusCloseBtn: document.getElementById('focus-close-btn'),
  focusEmpty: document.getElementById('focus-empty'),
  focusName: document.getElementById('focus-name'),
  focusOverlay: document.getElementById('focus-overlay'),
  focusRole: document.getElementById('focus-role'),
  focusVideo: document.getElementById('focus-video'),
  joinBtn: document.getElementById('join-btn'),
  joinForm: document.getElementById('join-form'),
  joinMessage: document.getElementById('join-message'),
  joinView: document.getElementById('join-view'),
  leaveBtn: document.getElementById('leave-btn'),
  meetingView: document.getElementById('meeting-view'),
  nameInput: document.getElementById('name-input'),
  participantList: document.getElementById('participant-list'),
  roomInput: document.getElementById('room-input'),
  roomTitle: document.getElementById('room-title'),
  seatGrid: document.querySelector('.seat-grid'),
  seatTemplate: document.getElementById('seat-template'),
  videoBtn: document.getElementById('video-btn'),
  virtualBtn: document.getElementById('virtual-btn'),
  zoomInBtn: document.getElementById('zoom-in-btn'),
  zoomOutBtn: document.getElementById('zoom-out-btn'),
};

const slotElements = SLOT_ORDER.reduce((acc, slotName) => {
  acc[slotName] = document.querySelector(`.seat-slot[data-slot="${slotName}"]`);
  return acc;
}, {});

const state = {
  cameraTrackBeforeShare: null,
  displayName: '',
  focusParticipantId: null,
  intentionalLeave: false,
  isScreenSharing: false,
  joinCounter: 0,
  joined: false,
  localId: null,
  mediaMode: 'none',
  localViewZoom: MIN_LOCAL_VIEW_ZOOM,
  localStream: null,
  participantViews: new Map(),
  peerConnections: new Map(),
  renderFrameId: null,
  roomId: '',
  screenShareStopHandler: null,
  screenStream: null,
  virtualEnabled: false,
  ws: null,
};

class ParticipantView {
  constructor({ id, isLocal, name, joinOrder }) {
    this.id = id;
    this.isLocal = Boolean(isLocal);
    this.name = name;
    this.joinOrder = joinOrder;
    this.stream = null;
    this.poseBusy = false;
    this.lastPoseAt = 0;
    this.poseEstimator = null;
    this.poseLandmarks = null;
    this.poseCache = new Map();
    this.audio = null;
    this.disposed = false;
    this.avatarSeed = hashString(this.id || this.name || 'seed');
    this.palette = pickAvatarPalette(this.id, this.isLocal);

    const node = elements.seatTemplate.content.firstElementChild.cloneNode(true);
    this.root = node;
    this.root.dataset.participantId = this.id;
    this.canvas = node.querySelector('.seat-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.video = node.querySelector('.seat-video');
    this.nameEl = node.querySelector('.seat-name');
    this.roleEl = node.querySelector('.seat-role');

    this.updateName(name);
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;

    if (!this.isLocal) {
      this.audio = document.createElement('audio');
      this.audio.autoplay = true;
      this.audio.playsInline = true;
      this.audio.style.display = 'none';
      this.root.appendChild(this.audio);
    }

    if (this.isLocal) {
      this.roleEl.textContent = '나';
    } else {
      this.roleEl.textContent = '동료';
    }
  }

  updateName(name) {
    this.name = name || '참석자';
    this.nameEl.textContent = this.name;
    if (state.focusParticipantId === this.id) {
      syncFocusView();
    }
  }

  attachStream(stream) {
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.play().catch(() => {
      // Browser autoplay policy can reject; the next user interaction retries naturally.
    });

    if (this.audio) {
      this.audio.srcObject = stream;
      this.audio.muted = false;
      this.audio.play().catch(() => {
        // Ignore autoplay rejection for remote audio.
      });
    }

    if (!FORCE_SIMPLE_CAMERA_MODE && state.virtualEnabled) {
      this.ensurePoseEstimator();
    }

    if (state.focusParticipantId === this.id) {
      syncFocusView();
    }
  }

  ensurePoseEstimator() {
    if (this.poseEstimator || !state.virtualEnabled || typeof window.Pose !== 'function') {
      return;
    }

    try {
      this.poseEstimator = new window.Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
      });
      this.poseEstimator.setOptions({
        modelComplexity: 0,
        smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.poseEstimator.onResults((results) => {
        if (!this.disposed) {
          this.poseLandmarks = results.poseLandmarks || null;
        }
      });
    } catch (error) {
      console.warn('Pose init failed:', error);
      this.poseEstimator = null;
    }
  }

  async requestPose(now) {
    if (
      !this.poseEstimator ||
      this.poseBusy ||
      this.video.readyState < 2 ||
      now - this.lastPoseAt < 66
    ) {
      return;
    }

    this.poseBusy = true;
    this.lastPoseAt = now;

    try {
      await this.poseEstimator.send({ image: this.video });
    } catch (_error) {
      this.poseLandmarks = null;
    } finally {
      this.poseBusy = false;
    }
  }

  draw(now) {
    if (!this.ctx || this.disposed) {
      return;
    }

    const cssWidth = this.canvas.clientWidth || 640;
    const cssHeight = this.canvas.clientHeight || 540;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, cssWidth, cssHeight);

    drawSeatBackground(this.ctx, cssWidth, cssHeight);
    drawChairBack(this.ctx, cssWidth, cssHeight);

    const canRenderVideo = this.canRenderVideo();

    if (canRenderVideo) {
      if (!FORCE_SIMPLE_CAMERA_MODE && state.virtualEnabled) {
        this.ensurePoseEstimator();
        this.requestPose(now);
        this.drawAvatarCharacter(cssWidth, cssHeight, now);
      } else {
        this.drawSimpleVideo(cssWidth, cssHeight);
      }
    } else {
      drawPlaceholder(this.ctx, cssWidth, cssHeight, '카메라 대기중');
    }

    drawChairFront(this.ctx, cssWidth, cssHeight);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  canRenderVideo() {
    if (!this.stream || this.video.readyState < 2) {
      return false;
    }

    const track = this.stream.getVideoTracks()[0];
    if (!track) {
      return false;
    }

    return track.enabled;
  }

  drawSimpleVideo(width, height) {
    const x = width * 0.14;
    const y = height * 0.08;
    const w = width * 0.72;
    const h = height * 0.82;
    const zoom = this.isLocal ? state.localViewZoom : 1;

    this.ctx.save();
    roundedRectPath(this.ctx, x, y, w, h, 24);
    this.ctx.clip();
    if (this.isLocal && !isScreenStream(this.stream)) {
      this.ctx.translate(x + w, y);
      this.ctx.scale(-1, 1);
      drawCoverImage(this.ctx, this.video, 0, 0, w, h, zoom);
    } else {
      drawCoverImage(this.ctx, this.video, x, y, w, h, zoom);
    }
    this.ctx.restore();
  }

  getPosePoint(index, frame) {
    const key = String(index);
    const cached = this.poseCache.get(key);
    const lm = this.poseLandmarks ? this.poseLandmarks[index] : null;

    if (!lm) {
      if (!cached) {
        return null;
      }
      return { ...cached, visibility: cached.visibility * 0.93 };
    }

    const raw = {
      x: clamp(frame.x + lm.x * frame.w, frame.x + frame.w * 0.04, frame.x + frame.w * 0.96),
      y: clamp(frame.y + lm.y * frame.h, frame.y + frame.h * 0.02, frame.y + frame.h * 0.98),
      visibility: lm.visibility ?? 1,
    };

    if (!cached) {
      this.poseCache.set(key, raw);
      return raw;
    }

    const blend = raw.visibility > 0.65 ? 0.44 : 0.26;
    const smooth = {
      x: cached.x + (raw.x - cached.x) * blend,
      y: cached.y + (raw.y - cached.y) * blend,
      visibility: cached.visibility + (raw.visibility - cached.visibility) * 0.4,
    };
    this.poseCache.set(key, smooth);
    return smooth;
  }

  drawAvatarCharacter(width, height, now) {
    const frame = {
      x: width * 0.16,
      y: height * 0.06,
      w: width * 0.68,
      h: height * 0.84,
    };
    const leftShoulder = this.getPosePoint(11, frame);
    const rightShoulder = this.getPosePoint(12, frame);
    const leftHip = this.getPosePoint(23, frame);
    const rightHip = this.getPosePoint(24, frame);

    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
      this.drawAvatarIdle(width, height, now);
      return;
    }

    const leftElbowRaw = this.getPosePoint(13, frame) || lerpPoint(leftShoulder, leftHip, 0.38);
    const rightElbowRaw = this.getPosePoint(14, frame) || lerpPoint(rightShoulder, rightHip, 0.38);
    const leftWristRaw = this.getPosePoint(15, frame) || lerpPoint(leftElbowRaw, leftHip, 0.36);
    const rightWristRaw = this.getPosePoint(16, frame) || lerpPoint(rightElbowRaw, rightHip, 0.36);
    const leftKnee = this.getPosePoint(25, frame) || lerpPoint(leftHip, { x: leftHip.x, y: height * 0.9 }, 0.45);
    const rightKnee =
      this.getPosePoint(26, frame) || lerpPoint(rightHip, { x: rightHip.x, y: height * 0.9 }, 0.45);
    const leftAnkle =
      this.getPosePoint(27, frame) || lerpPoint(leftKnee, { x: leftKnee.x, y: height * 0.94 }, 0.44);
    const rightAnkle =
      this.getPosePoint(28, frame) || lerpPoint(rightKnee, { x: rightKnee.x, y: height * 0.94 }, 0.44);

    const shouldersCenter = midpoint(leftShoulder, rightShoulder);
    const hipsCenter = midpoint(leftHip, rightHip);
    const shoulderWidth = Math.max(16, distance(leftShoulder, rightShoulder));
    const torsoHeight = Math.max(26, distance(shouldersCenter, hipsCenter));
    const headRadius = clamp(shoulderWidth * 0.43, 18, 42);
    const nose = this.getPosePoint(0, frame);
    const leftEye = this.getPosePoint(2, frame);
    const rightEye = this.getPosePoint(5, frame);
    const headX = nose
      ? clamp(nose.x, frame.x + frame.w * 0.2, frame.x + frame.w * 0.8)
      : shouldersCenter.x;
    const headY = nose
      ? clamp(nose.y - headRadius * 0.45, frame.y + headRadius, shouldersCenter.y - headRadius * 0.22)
      : shouldersCenter.y - torsoHeight * 0.86;
    const headAngle = leftEye && rightEye
      ? clamp(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x), -0.45, 0.45)
      : clamp((rightShoulder.y - leftShoulder.y) / Math.max(20, shoulderWidth * 2.5), -0.24, 0.24);

    const baseLeftPaw = {
      x: shouldersCenter.x - shoulderWidth * 0.52,
      y: shouldersCenter.y + torsoHeight * 0.48,
    };
    const baseRightPaw = {
      x: shouldersCenter.x + shoulderWidth * 0.52,
      y: shouldersCenter.y + torsoHeight * 0.48,
    };

    const trackedLeftPaw = {
      x: clamp(leftWristRaw.x, frame.x + frame.w * 0.12, frame.x + frame.w * 0.88),
      y: clamp(leftWristRaw.y, frame.y + frame.h * 0.18, frame.y + frame.h * 0.88),
    };
    const trackedRightPaw = {
      x: clamp(rightWristRaw.x, frame.x + frame.w * 0.12, frame.x + frame.w * 0.88),
      y: clamp(rightWristRaw.y, frame.y + frame.h * 0.18, frame.y + frame.h * 0.88),
    };

    const pawLeft = lerpPoint(baseLeftPaw, trackedLeftPaw, 0.78);
    const pawRight = lerpPoint(baseRightPaw, trackedRightPaw, 0.78);
    const elbowLeft = lerpPoint(leftShoulder, pawLeft, 0.45);
    const elbowRight = lerpPoint(rightShoulder, pawRight, 0.45);
    const pawLift =
      (shouldersCenter.y - (pawLeft.y + pawRight.y) * 0.5) / Math.max(20, torsoHeight * 0.88);
    const smile = clamp(0.12 + pawLift * 0.58, -0.12, 0.58);
    const eyeOpen = Math.sin(now / 170 + this.avatarSeed * 0.007) > 0.986 ? 0.08 : 0.98;
    const footLeft = {
      x: clamp(hipsCenter.x - shoulderWidth * 0.4, frame.x + frame.w * 0.22, frame.x + frame.w * 0.78),
      y: clamp((leftAnkle.y + height * 0.8) * 0.5, height * 0.72, height * 0.89),
    };
    const footRight = {
      x: clamp(hipsCenter.x + shoulderWidth * 0.4, frame.x + frame.w * 0.22, frame.x + frame.w * 0.78),
      y: clamp((rightAnkle.y + height * 0.8) * 0.5, height * 0.72, height * 0.89),
    };

    this.drawFurryAvatar(
      {
        width,
        height,
        head: {
          x: headX,
          y: headY,
          r: headRadius,
          angle: headAngle,
          look: clamp((headX - shouldersCenter.x) / Math.max(14, shoulderWidth), -0.85, 0.85),
        },
        shoulderLeft,
        shoulderRight,
        shouldersCenter,
        hipsCenter,
        elbowLeft,
        elbowRight,
        pawLeft,
        pawRight,
        footLeft,
        footRight,
        eyeOpen,
        smile,
        pawLift: clamp(pawLift, -0.4, 0.9),
      },
      now,
    );
  }

  drawAvatarIdle(width, height, now) {
    const sway = Math.sin(now / 620 + this.avatarSeed * 0.01);
    const bob = Math.sin(now / 350 + this.avatarSeed * 0.015) * 4;
    const centerX = width * 0.5 + sway * 5.5;
    const shoulderWidth = width * 0.24;
    const torsoHeight = height * 0.24;
    const shouldersCenter = { x: centerX, y: height * 0.44 + bob };
    const hipsCenter = { x: centerX, y: shouldersCenter.y + torsoHeight };
    const shoulderLeft = { x: centerX - shoulderWidth * 0.5, y: shouldersCenter.y - 2 };
    const shoulderRight = { x: centerX + shoulderWidth * 0.5, y: shouldersCenter.y - 2 };
    const pawLeft = {
      x: centerX - shoulderWidth * 0.63 + Math.sin(now / 280 + this.avatarSeed * 0.008) * 2,
      y: shouldersCenter.y + torsoHeight * 0.42 + Math.cos(now / 340) * 2,
    };
    const pawRight = {
      x: centerX + shoulderWidth * 0.63 - Math.cos(now / 300 + this.avatarSeed * 0.006) * 2,
      y: shouldersCenter.y + torsoHeight * 0.42 + Math.sin(now / 360) * 2,
    };
    const footLeft = { x: centerX - shoulderWidth * 0.42, y: height * 0.81 };
    const footRight = { x: centerX + shoulderWidth * 0.42, y: height * 0.81 };
    const headRadius = clamp(shoulderWidth * 0.42, 20, 38);
    const blink = Math.sin(now / 190 + this.avatarSeed * 0.007) > 0.988 ? 0.06 : 0.98;

    this.drawFurryAvatar(
      {
        width,
        height,
        head: {
          x: centerX + sway * 3,
          y: shouldersCenter.y - torsoHeight * 0.76,
          r: headRadius,
          angle: sway * 0.09,
          look: sway * 0.35,
        },
        shoulderLeft,
        shoulderRight,
        shouldersCenter,
        hipsCenter,
        elbowLeft: lerpPoint(shoulderLeft, pawLeft, 0.44),
        elbowRight: lerpPoint(shoulderRight, pawRight, 0.44),
        pawLeft,
        pawRight,
        footLeft,
        footRight,
        eyeOpen: blink,
        smile: 0.24,
        pawLift: 0.06,
      },
      now,
    );
  }

  drawFurryAvatar(rig, now) {
    const ctx = this.ctx;
    const palette = this.palette;
    const seedWave = Math.sin(now / 520 + this.avatarSeed * 0.002);

    const tailBase = {
      x: rig.hipsCenter.x + rig.head.look * rig.head.r * 0.22,
      y: rig.hipsCenter.y + rig.head.r * 0.6,
    };
    const tailMid = {
      x: tailBase.x + seedWave * rig.head.r * 0.7,
      y: tailBase.y - rig.head.r * 0.44,
    };
    const tailTip = {
      x: tailMid.x + Math.sin(now / 340 + this.avatarSeed * 0.01) * rig.head.r * 0.78,
      y: tailMid.y - rig.head.r * 0.24,
    };

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.ellipse(rig.width * 0.5, rig.height * 0.8, rig.width * 0.16, rig.height * 0.046, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.strokeStyle = palette.furShadow;
    ctx.lineWidth = rig.head.r * 0.95;
    ctx.beginPath();
    ctx.moveTo(tailBase.x, tailBase.y);
    ctx.quadraticCurveTo(tailMid.x, tailMid.y, tailTip.x, tailTip.y);
    ctx.stroke();

    ctx.strokeStyle = palette.fur;
    ctx.lineWidth = rig.head.r * 0.64;
    ctx.beginPath();
    ctx.moveTo(tailBase.x, tailBase.y);
    ctx.quadraticCurveTo(tailMid.x, tailMid.y, tailTip.x, tailTip.y);
    ctx.stroke();

    this.drawBackPaw(rig.footLeft, rig.head.r * 0.42, -0.18);
    this.drawBackPaw(rig.footRight, rig.head.r * 0.42, 0.18);

    const bodyTop = rig.shouldersCenter.y - rig.head.r * 0.14;
    const bodyBottom = rig.hipsCenter.y + rig.head.r * 0.82;
    const bodyLeft = rig.shoulderLeft.x - rig.head.r * 0.35;
    const bodyRight = rig.shoulderRight.x + rig.head.r * 0.35;
    const hoodieGrad = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
    hoodieGrad.addColorStop(0, palette.hoodie);
    hoodieGrad.addColorStop(1, palette.hoodieShadow);
    ctx.fillStyle = hoodieGrad;
    ctx.beginPath();
    ctx.moveTo(bodyLeft + rig.head.r * 0.5, bodyTop);
    ctx.quadraticCurveTo(rig.shouldersCenter.x, bodyTop - rig.head.r * 0.26, bodyRight - rig.head.r * 0.5, bodyTop);
    ctx.quadraticCurveTo(bodyRight + rig.head.r * 0.2, rig.hipsCenter.y, rig.hipsCenter.x + rig.head.r * 0.62, bodyBottom);
    ctx.quadraticCurveTo(rig.hipsCenter.x, bodyBottom + rig.head.r * 0.16, rig.hipsCenter.x - rig.head.r * 0.62, bodyBottom);
    ctx.quadraticCurveTo(bodyLeft - rig.head.r * 0.2, rig.hipsCenter.y, bodyLeft + rig.head.r * 0.5, bodyTop);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = Math.max(1.5, rig.head.r * 0.06);
    ctx.beginPath();
    ctx.moveTo(rig.shouldersCenter.x, bodyTop + rig.head.r * 0.06);
    ctx.lineTo(rig.shouldersCenter.x, bodyBottom - rig.head.r * 0.18);
    ctx.stroke();

    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(rig.shouldersCenter.x, bodyTop + rig.head.r * 0.24, rig.head.r * 0.08, 0, Math.PI * 2);
    ctx.fill();

    this.drawLimb(rig.shoulderLeft, rig.elbowLeft, rig.pawLeft, rig.head.r * 0.31, palette.hoodieShadow);
    this.drawLimb(rig.shoulderRight, rig.elbowRight, rig.pawRight, rig.head.r * 0.31, palette.hoodieShadow);

    ctx.fillStyle = palette.fur;
    ctx.beginPath();
    ctx.ellipse(rig.shoulderLeft.x - rig.head.r * 0.18, rig.elbowLeft.y, rig.head.r * 0.16, rig.head.r * 0.12, -0.6, 0, Math.PI * 2);
    ctx.ellipse(rig.shoulderRight.x + rig.head.r * 0.18, rig.elbowRight.y, rig.head.r * 0.16, rig.head.r * 0.12, 0.6, 0, Math.PI * 2);
    ctx.fill();

    this.drawPaw(rig.pawLeft, rig.head.r * 0.28, rig.pawLift);
    this.drawPaw(rig.pawRight, rig.head.r * 0.28, rig.pawLift);

    this.drawHead(rig, now);
    ctx.restore();
  }

  drawHead(rig, now) {
    const ctx = this.ctx;
    const palette = this.palette;
    const earWiggle = Math.sin(now / 420 + this.avatarSeed * 0.011) * 0.12;

    ctx.save();
    ctx.translate(rig.head.x, rig.head.y);
    ctx.rotate(rig.head.angle);

    this.drawEar({ x: -rig.head.r * 0.62, y: -rig.head.r * 0.72 }, rig.head.r * 0.62, -0.28 + earWiggle);
    this.drawEar({ x: rig.head.r * 0.62, y: -rig.head.r * 0.72 }, rig.head.r * 0.62, 0.28 - earWiggle);

    ctx.fillStyle = palette.fur;
    ctx.beginPath();
    ctx.arc(0, 0, rig.head.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = palette.furShadow;
    ctx.beginPath();
    ctx.arc(-rig.head.r * 0.7, rig.head.r * 0.18, rig.head.r * 0.27, 0, Math.PI * 2);
    ctx.arc(rig.head.r * 0.7, rig.head.r * 0.18, rig.head.r * 0.27, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = palette.fur;
    ctx.beginPath();
    ctx.moveTo(-rig.head.r * 0.3, -rig.head.r * 0.66);
    ctx.quadraticCurveTo(0, -rig.head.r * 1.06, rig.head.r * 0.3, -rig.head.r * 0.66);
    ctx.quadraticCurveTo(0, -rig.head.r * 0.7, -rig.head.r * 0.3, -rig.head.r * 0.66);
    ctx.fill();

    const eyeY = -rig.head.r * 0.05;
    const eyeX = rig.head.r * 0.33;
    const eyeH = Math.max(rig.head.r * 0.08, rig.head.r * 0.13 * rig.eyeOpen);
    ctx.fillStyle = palette.eye;
    if (rig.eyeOpen < 0.2) {
      ctx.lineWidth = Math.max(1.6, rig.head.r * 0.07);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-eyeX - rig.head.r * 0.09, eyeY);
      ctx.lineTo(-eyeX + rig.head.r * 0.09, eyeY);
      ctx.moveTo(eyeX - rig.head.r * 0.09, eyeY);
      ctx.lineTo(eyeX + rig.head.r * 0.09, eyeY);
      ctx.strokeStyle = palette.eye;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(-eyeX, eyeY, rig.head.r * 0.11, eyeH, 0, 0, Math.PI * 2);
      ctx.ellipse(eyeX, eyeY, rig.head.r * 0.11, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(-eyeX + rig.head.r * 0.03, eyeY - eyeH * 0.26, rig.head.r * 0.025, 0, Math.PI * 2);
      ctx.arc(eyeX + rig.head.r * 0.03, eyeY - eyeH * 0.26, rig.head.r * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = palette.blush;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.ellipse(-rig.head.r * 0.55, rig.head.r * 0.16, rig.head.r * 0.19, rig.head.r * 0.11, 0, 0, Math.PI * 2);
    ctx.ellipse(rig.head.r * 0.55, rig.head.r * 0.16, rig.head.r * 0.19, rig.head.r * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = palette.paw;
    ctx.beginPath();
    ctx.moveTo(0, rig.head.r * 0.13);
    ctx.lineTo(-rig.head.r * 0.08, rig.head.r * 0.24);
    ctx.lineTo(rig.head.r * 0.08, rig.head.r * 0.24);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = palette.paw;
    ctx.lineWidth = Math.max(1.2, rig.head.r * 0.055);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-rig.head.r * 0.02, rig.head.r * 0.27);
    ctx.quadraticCurveTo(-rig.head.r * 0.12, rig.head.r * (0.34 + rig.smile * 0.22), -rig.head.r * 0.2, rig.head.r * 0.3);
    ctx.moveTo(rig.head.r * 0.02, rig.head.r * 0.27);
    ctx.quadraticCurveTo(rig.head.r * 0.12, rig.head.r * (0.34 + rig.smile * 0.22), rig.head.r * 0.2, rig.head.r * 0.3);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(45, 58, 82, 0.5)';
    ctx.lineWidth = Math.max(1, rig.head.r * 0.03);
    ctx.beginPath();
    ctx.moveTo(-rig.head.r * 0.75, rig.head.r * 0.22);
    ctx.lineTo(-rig.head.r * 0.38, rig.head.r * 0.24);
    ctx.moveTo(rig.head.r * 0.75, rig.head.r * 0.22);
    ctx.lineTo(rig.head.r * 0.38, rig.head.r * 0.24);
    ctx.stroke();

    ctx.fillStyle = palette.hoodie;
    roundedRectPath(ctx, -rig.head.r * 0.52, rig.head.r * 0.7, rig.head.r * 1.04, rig.head.r * 0.28, rig.head.r * 0.11);
    ctx.fill();
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(0, rig.head.r * 0.84, rig.head.r * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(141, 108, 34, 0.8)';
    ctx.lineWidth = Math.max(1, rig.head.r * 0.04);
    ctx.beginPath();
    ctx.arc(0, rig.head.r * 0.84, rig.head.r * 0.07, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  drawEar(anchor, size, angle) {
    const ctx = this.ctx;
    const palette = this.palette;
    ctx.save();
    ctx.translate(anchor.x, anchor.y);
    ctx.rotate(angle);

    ctx.fillStyle = palette.furShadow;
    ctx.beginPath();
    ctx.moveTo(-size * 0.4, size * 0.22);
    ctx.quadraticCurveTo(-size * 0.48, -size * 0.3, 0, -size);
    ctx.quadraticCurveTo(size * 0.49, -size * 0.3, size * 0.4, size * 0.22);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = palette.innerEar;
    ctx.beginPath();
    ctx.moveTo(-size * 0.2, size * 0.08);
    ctx.quadraticCurveTo(-size * 0.24, -size * 0.24, 0, -size * 0.72);
    ctx.quadraticCurveTo(size * 0.24, -size * 0.24, size * 0.2, size * 0.08);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawLimb(start, middle, end, width, color) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(middle.x, middle.y, end.x, end.y);
    ctx.stroke();
  }

  drawPaw(point, size, lift) {
    const ctx = this.ctx;
    const palette = this.palette;
    const squash = clamp(1 - lift * 0.28, 0.76, 1.02);
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.scale(1, squash);

    ctx.fillStyle = palette.paw;
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 1.02, size * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = palette.pawPad;
    ctx.beginPath();
    ctx.ellipse(0, size * 0.15, size * 0.36, size * 0.3, 0, 0, Math.PI * 2);
    ctx.ellipse(-size * 0.42, -size * 0.24, size * 0.16, size * 0.14, 0, 0, Math.PI * 2);
    ctx.ellipse(-size * 0.15, -size * 0.34, size * 0.16, size * 0.14, 0, 0, Math.PI * 2);
    ctx.ellipse(size * 0.15, -size * 0.34, size * 0.16, size * 0.14, 0, 0, Math.PI * 2);
    ctx.ellipse(size * 0.42, -size * 0.24, size * 0.16, size * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawBackPaw(point, size, tilt) {
    const ctx = this.ctx;
    const palette = this.palette;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(tilt);

    ctx.fillStyle = palette.furShadow;
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.95, size * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = palette.pawPad;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.ellipse(0, size * 0.03, size * 0.34, size * 0.24, 0, 0, Math.PI * 2);
    ctx.ellipse(-size * 0.36, -size * 0.17, size * 0.12, size * 0.1, 0, 0, Math.PI * 2);
    ctx.ellipse(-size * 0.12, -size * 0.24, size * 0.12, size * 0.1, 0, 0, Math.PI * 2);
    ctx.ellipse(size * 0.12, -size * 0.24, size * 0.12, size * 0.1, 0, 0, Math.PI * 2);
    ctx.ellipse(size * 0.36, -size * 0.17, size * 0.12, size * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  destroy() {
    this.disposed = true;
    this.poseLandmarks = null;
    this.poseEstimator = null;
    this.poseCache.clear();
    this.poseBusy = false;
    this.lastPoseAt = 0;
    if (this.audio) {
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
    this.root.remove();
    this.video.srcObject = null;
    if (state.focusParticipantId === this.id) {
      closeFocusView();
    }
  }
}

function hashString(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickAvatarPalette(id, isLocal) {
  if (isLocal) {
    return AVATAR_PALETTES[0];
  }
  const index = hashString(id || 'guest') % AVATAR_PALETTES.length;
  return AVATAR_PALETTES[index];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
  };
}

function lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function drawBone(ctx, a, b, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawJoint(ctx, point, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawSeatBackground(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#1f3f72');
  gradient.addColorStop(1, '#0a142d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const floorGradient = ctx.createLinearGradient(0, height * 0.66, 0, height);
  floorGradient.addColorStop(0, 'rgba(99, 134, 181, 0.2)');
  floorGradient.addColorStop(1, 'rgba(4, 8, 16, 0.8)');
  ctx.fillStyle = floorGradient;
  ctx.fillRect(0, height * 0.66, width, height * 0.34);
}

function drawChairBack(ctx, width, height) {
  const legColor = '#6f7f92';
  const backGradient = ctx.createLinearGradient(0, height * 0.12, 0, height * 0.52);
  backGradient.addColorStop(0, '#d8e6f7');
  backGradient.addColorStop(1, '#96afc8');

  ctx.fillStyle = legColor;
  ctx.fillRect(width * 0.29, height * 0.3, width * 0.03, height * 0.42);
  ctx.fillRect(width * 0.68, height * 0.3, width * 0.03, height * 0.42);

  ctx.fillStyle = backGradient;
  roundedRectPath(ctx, width * 0.25, height * 0.12, width * 0.5, height * 0.35, 22);
  ctx.fill();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
  roundedRectPath(ctx, width * 0.3, height * 0.2, width * 0.4, height * 0.05, 10);
  ctx.fill();
}

function drawChairFront(ctx, width, height) {
  const seatGradient = ctx.createLinearGradient(0, height * 0.68, 0, height * 0.88);
  seatGradient.addColorStop(0, '#f4b34a');
  seatGradient.addColorStop(1, '#cf812a');

  ctx.fillStyle = seatGradient;
  roundedRectPath(ctx, width * 0.2, height * 0.69, width * 0.6, height * 0.18, 20);
  ctx.fill();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
  ctx.fillRect(width * 0.28, height * 0.81, width * 0.05, height * 0.13);
  ctx.fillRect(width * 0.67, height * 0.81, width * 0.05, height * 0.13);
}

function drawPlaceholder(ctx, width, height, message) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  roundedRectPath(ctx, width * 0.24, height * 0.2, width * 0.52, height * 0.36, 20);
  ctx.fill();

  ctx.fillStyle = '#e9f2ff';
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.31, width * 0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillRect(width * 0.43, height * 0.41, width * 0.14, height * 0.12);

  ctx.fillStyle = '#cfdeee';
  ctx.font = `${Math.max(12, width * 0.032)}px "Lexend", "Noto Sans KR", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(message, width * 0.5, height * 0.62);
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawCoverImage(ctx, source, x, y, width, height, zoom = 1) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;

  if (!sourceWidth || !sourceHeight) {
    return;
  }

  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const normalizedZoom = clamp(Number(zoom) || 1, MIN_LOCAL_VIEW_ZOOM, MAX_LOCAL_VIEW_ZOOM);
  const cropWidth = width / scale / normalizedZoom;
  const cropHeight = height / scale / normalizedZoom;
  const cropX = Math.max(0, (sourceWidth - cropWidth) / 2);
  const cropY = Math.max(0, (sourceHeight - cropHeight) / 2);

  ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
}

function getStreamVideoTrack(stream) {
  if (!stream) {
    return null;
  }
  return stream.getVideoTracks()[0] || null;
}

function isScreenTrack(track) {
  if (!track) {
    return false;
  }

  try {
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
    if (settings && settings.displaySurface) {
      return true;
    }
  } catch (_error) {
    // no-op
  }

  const label = String(track.label || '').toLowerCase();
  return (
    label.includes('screen') ||
    label.includes('window') ||
    label.includes('tab') ||
    label.includes('entire')
  );
}

function isScreenStream(stream) {
  return isScreenTrack(getStreamVideoTrack(stream));
}

function setFocusOverlayVisible(visible) {
  if (!elements.focusOverlay) {
    return;
  }

  elements.focusOverlay.classList.toggle('hidden', !visible);
  elements.focusOverlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function syncFocusView() {
  if (!state.focusParticipantId) {
    setFocusOverlayVisible(false);
    return;
  }

  const view = state.participantViews.get(state.focusParticipantId);
  if (!view) {
    closeFocusView();
    return;
  }

  setFocusOverlayVisible(true);

  if (elements.focusName) {
    elements.focusName.textContent = view.name || '참석자';
  }
  if (elements.focusRole) {
    elements.focusRole.textContent = view.isLocal ? '나' : '동료';
  }

  const stream = view.stream;
  const track = getStreamVideoTrack(stream);
  const hasVideo = Boolean(track && track.readyState === 'live');

  if (elements.focusVideo) {
    if (hasVideo) {
      if (elements.focusVideo.srcObject !== stream) {
        elements.focusVideo.srcObject = stream;
      }
      elements.focusVideo.classList.remove('hidden');
      if (elements.focusEmpty) {
        elements.focusEmpty.classList.add('hidden');
      }
      elements.focusVideo.play().catch(() => {
        // Browser autoplay policy can reject; user can click to resume.
      });
    } else {
      elements.focusVideo.srcObject = null;
      elements.focusVideo.classList.add('hidden');
      if (elements.focusEmpty) {
        elements.focusEmpty.classList.remove('hidden');
      }
    }
  }
}

function openFocusView(participantId) {
  if (!participantId) {
    return;
  }

  state.focusParticipantId = participantId;
  syncFocusView();

  if (
    elements.focusOverlay &&
    typeof elements.focusOverlay.requestFullscreen === 'function' &&
    !document.fullscreenElement
  ) {
    elements.focusOverlay.requestFullscreen().catch(() => {
      // If fullscreen is blocked, fixed overlay still provides large focus view.
    });
  }
}

function closeFocusView() {
  state.focusParticipantId = null;
  setFocusOverlayVisible(false);

  if (elements.focusVideo) {
    elements.focusVideo.pause();
    elements.focusVideo.srcObject = null;
    elements.focusVideo.classList.remove('hidden');
  }
  if (elements.focusEmpty) {
    elements.focusEmpty.classList.add('hidden');
  }

  if (
    elements.focusOverlay &&
    document.fullscreenElement === elements.focusOverlay &&
    typeof document.exitFullscreen === 'function'
  ) {
    document.exitFullscreen().catch(() => {
      // no-op
    });
  }
}

function handleSeatDoubleClick(event) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) {
    return;
  }

  const card = target.closest('.seat-card');
  if (!card) {
    return;
  }

  const participantId = card.dataset.participantId;
  if (!participantId) {
    return;
  }

  if (state.focusParticipantId === participantId) {
    closeFocusView();
    return;
  }

  openFocusView(participantId);
}

function getSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/signal`;
}

function setConnectionStatus(text, isOkay = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.style.borderColor = isOkay
    ? 'rgba(99, 255, 186, 0.5)'
    : 'rgba(255, 255, 255, 0.25)';
  elements.connectionStatus.style.color = isOkay ? '#e5ffef' : '#f4f8ff';
}

function setJoinMessage(text) {
  elements.joinMessage.textContent = text || '';
}

function sanitizeRoom(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32) || 'office-3';
}

function sanitizeName(value) {
  return String(value || '').trim().slice(0, 24) || '참석자';
}

function addLog(message) {
  const item = document.createElement('li');
  const time = new Date().toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  item.textContent = `${time} ${message}`;
  elements.eventLog.prepend(item);

  while (elements.eventLog.children.length > MAX_LOG) {
    elements.eventLog.removeChild(elements.eventLog.lastElementChild);
  }
}

function updateCapacity(count = state.participantViews.size, maxParticipants = 3) {
  elements.capacityText.textContent = `${count} / ${maxParticipants}`;
}

function addOrUpdateParticipant({ id, isLocal = false, name }) {
  let view = state.participantViews.get(id);

  if (!view) {
    view = new ParticipantView({
      id,
      isLocal,
      name,
      joinOrder: state.joinCounter++,
    });
    state.participantViews.set(id, view);
  }

  view.isLocal = Boolean(isLocal);
  view.updateName(name || '참석자');
  view.roleEl.textContent = view.isLocal ? '나' : '동료';
  view.video.muted = true;

  if (view.isLocal) {
    state.localId = id;
  }

  layoutSeats();
  updateParticipantList();
  updateCapacity();
  return view;
}

function removeParticipant(id) {
  const view = state.participantViews.get(id);
  if (!view) {
    return;
  }

  view.destroy();
  state.participantViews.delete(id);

  if (state.localId === id) {
    state.localId = null;
  }

  layoutSeats();
  updateParticipantList();
  updateCapacity();
}

function layoutSeats() {
  for (const slotName of SLOT_ORDER) {
    const slot = slotElements[slotName];
    slot.textContent = '';
  }

  const localView = state.localId ? state.participantViews.get(state.localId) : null;
  const remoteViews = Array.from(state.participantViews.values())
    .filter((view) => !view.isLocal)
    .sort((a, b) => a.joinOrder - b.joinOrder);

  const assignments = new Map();

  if (localView) {
    assignments.set('center', localView);
  }

  const remainingSlots = localView ? ['left', 'right'] : ['center', 'left', 'right'];
  for (let i = 0; i < remoteViews.length; i += 1) {
    const slot = remainingSlots[i];
    if (!slot) {
      break;
    }
    assignments.set(slot, remoteViews[i]);
  }

  for (const slotName of SLOT_ORDER) {
    const slot = slotElements[slotName];
    const assignedView = assignments.get(slotName);

    if (!assignedView) {
      const empty = document.createElement('div');
      empty.className = 'empty-seat';
      empty.textContent = SLOT_LABELS[slotName];
      slot.appendChild(empty);
      continue;
    }

    slot.appendChild(assignedView.root);
  }
}

function updateParticipantList() {
  const entries = Array.from(state.participantViews.values()).sort((a, b) => {
    if (a.isLocal && !b.isLocal) {
      return -1;
    }
    if (!a.isLocal && b.isLocal) {
      return 1;
    }
    return a.joinOrder - b.joinOrder;
  });

  elements.participantList.textContent = '';

  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = '참석자가 없습니다.';
    elements.participantList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement('li');
    const label = entry.isLocal ? ' (나)' : '';
    item.innerHTML = `<strong>${escapeHtml(entry.name)}</strong>${label}`;
    elements.participantList.appendChild(item);
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendSignal(to, signal) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.ws.send(
    JSON.stringify({
      type: 'signal',
      to,
      signal,
    }),
  );
}

function createPeerConnection(peerId, shouldCreateOffer) {
  const existing = state.peerConnections.get(peerId);
  if (existing) {
    return existing;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const connection = {
    pc,
    pendingCandidates: [],
  };

  state.peerConnections.set(peerId, connection);

  let hasLocalAudio = false;
  let hasLocalVideo = false;
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
      if (track.kind === 'audio') {
        hasLocalAudio = true;
      } else if (track.kind === 'video') {
        hasLocalVideo = true;
      }
    }
  }

  // Keep receiving peer media even when local camera/mic is unavailable.
  if (!hasLocalAudio) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
  if (!hasLocalVideo) {
    pc.addTransceiver('video', { direction: 'sendrecv' });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(peerId, { candidate: event.candidate });
    }
  };

  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== 'stable') {
      return;
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(peerId, { sdp: pc.localDescription });
    } catch (error) {
      console.warn('Renegotiation failed:', error);
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) {
      return;
    }

    const participant = addOrUpdateParticipant({ id: peerId, isLocal: false, name: `참석자-${peerId}` });
    participant.attachStream(stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeerConnection(peerId);
      removeParticipant(peerId);
    }
  };

  if (shouldCreateOffer) {
    createAndSendOffer(peerId).catch((error) => {
      console.error('Offer failed:', error);
    });
  }

  return connection;
}

async function createAndSendOffer(peerId) {
  const connection = state.peerConnections.get(peerId);
  if (!connection) {
    return;
  }

  const { pc } = connection;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(peerId, { sdp: pc.localDescription });
}

async function flushPendingCandidates(connection) {
  if (!connection || !connection.pendingCandidates.length) {
    return;
  }

  const queue = connection.pendingCandidates.splice(0, connection.pendingCandidates.length);
  for (const candidate of queue) {
    try {
      await connection.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Failed to add queued candidate:', error);
    }
  }
}

async function handleSignalMessage(message) {
  const { from, signal } = message;
  if (!from || !signal) {
    return;
  }

  let connection = state.peerConnections.get(from);
  if (!connection) {
    connection = createPeerConnection(from, false);
  }

  const { pc } = connection;

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    await flushPendingCandidates(connection);

    if (signal.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { sdp: pc.localDescription });
    }
    return;
  }

  if (signal.candidate) {
    const candidate = new RTCIceCandidate(signal.candidate);
    if (pc.remoteDescription && pc.remoteDescription.type) {
      await pc.addIceCandidate(candidate);
    } else {
      connection.pendingCandidates.push(candidate);
    }
  }
}

function closePeerConnection(peerId) {
  const connection = state.peerConnections.get(peerId);
  if (!connection) {
    return;
  }

  state.peerConnections.delete(peerId);
  try {
    connection.pc.onicecandidate = null;
    connection.pc.onnegotiationneeded = null;
    connection.pc.ontrack = null;
    connection.pc.close();
  } catch (_error) {
    // no-op
  }
}

function closeAllPeerConnections() {
  for (const peerId of Array.from(state.peerConnections.keys())) {
    closePeerConnection(peerId);
  }
}

async function replaceOutgoingVideoTrack(nextTrack) {
  for (const connection of state.peerConnections.values()) {
    const { pc } = connection;
    let sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video') || null;

    if (!sender) {
      const transceiver = pc
        .getTransceivers()
        .find((item) => item.receiver && item.receiver.track && item.receiver.track.kind === 'video');
      if (transceiver) {
        sender = transceiver.sender || null;
        try {
          transceiver.direction = nextTrack ? 'sendrecv' : 'recvonly';
        } catch (_error) {
          // no-op
        }
      }
    }

    try {
      if (sender) {
        await sender.replaceTrack(nextTrack || null);
      } else if (nextTrack) {
        pc.addTrack(nextTrack, state.localStream);
      }
    } catch (error) {
      console.warn('Video track replace failed:', error);
    }
  }
}

function syncLocalPreview() {
  if (!state.localId || !state.localStream) {
    return;
  }
  const me = state.participantViews.get(state.localId);
  if (me) {
    me.attachStream(state.localStream);
  }
}

function canShareScreen() {
  return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}

function hasLocalVideoTrack() {
  return Boolean(state.localStream && getStreamVideoTrack(state.localStream));
}

function syncZoomButtons() {
  const zoomInBtn = elements.zoomInBtn;
  const zoomOutBtn = elements.zoomOutBtn;
  if (!zoomInBtn || !zoomOutBtn) {
    return;
  }

  const canZoom = state.joined && hasLocalVideoTrack();
  const displayZoom = state.localViewZoom.toFixed(1);

  zoomOutBtn.textContent = `축소 - (${displayZoom}x)`;
  zoomInBtn.textContent = `확대 + (${displayZoom}x)`;

  if (!canZoom) {
    zoomOutBtn.disabled = true;
    zoomInBtn.disabled = true;
    return;
  }

  zoomOutBtn.disabled = state.localViewZoom <= MIN_LOCAL_VIEW_ZOOM;
  zoomInBtn.disabled = state.localViewZoom >= MAX_LOCAL_VIEW_ZOOM;
}

function setLocalViewZoom(nextZoom) {
  state.localViewZoom = clamp(nextZoom, MIN_LOCAL_VIEW_ZOOM, MAX_LOCAL_VIEW_ZOOM);
  syncZoomButtons();
}

function zoomLocalView(step) {
  setLocalViewZoom(Number((state.localViewZoom + step).toFixed(2)));
}

function syncShareButton() {
  const button = elements.virtualBtn;
  if (!button) {
    return;
  }

  if (!canShareScreen()) {
    button.disabled = true;
    button.textContent = '화면공유 미지원';
    button.classList.remove('active');
    return;
  }

  if (!state.joined) {
    button.disabled = true;
    button.textContent = '화면공유 시작';
    button.classList.remove('active');
    return;
  }

  button.disabled = false;
  button.textContent = state.isScreenSharing ? '화면공유 중지' : '화면공유 시작';
  button.classList.toggle('active', state.isScreenSharing);
}

async function handleServerMessage(message) {
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'joined': {
      state.joined = true;
      state.localId = message.selfId;
      elements.roomTitle.textContent = `회의 코드: ${state.roomId}`;
      elements.joinView.classList.add('hidden');
      elements.meetingView.classList.remove('hidden');
      setConnectionStatus('회의 연결됨', true);
      syncShareButton();

      const me = addOrUpdateParticipant({
        id: message.selfId,
        isLocal: true,
        name: state.displayName,
      });

      if (state.localStream) {
        me.attachStream(state.localStream);
      }

      if (Array.isArray(message.peers)) {
        for (const peer of message.peers) {
          addOrUpdateParticipant({
            id: peer.id,
            isLocal: false,
            name: peer.name,
          });
          createPeerConnection(peer.id, true);
        }
      }

      updateCapacity(state.participantViews.size, message.maxParticipants || 3);
      addLog(`${state.displayName}님이 참석했습니다.`);
      if (state.mediaMode === 'video-only') {
        addLog('마이크 없이 카메라 전용으로 연결되었습니다.');
      } else if (state.mediaMode === 'audio-only') {
        addLog('카메라 없이 음성 전용으로 연결되었습니다.');
      } else if (state.mediaMode === 'none') {
        addLog('카메라/마이크 없이 관전자 모드로 연결되었습니다.');
      }
      startRenderLoop();
      break;
    }

    case 'peer-joined': {
      const peer = message.peer;
      if (!peer || !peer.id) {
        break;
      }

      addOrUpdateParticipant({
        id: peer.id,
        isLocal: false,
        name: peer.name,
      });
      createPeerConnection(peer.id, false);
      addLog(`${peer.name}님이 참석했습니다.`);
      break;
    }

    case 'peer-left': {
      if (!message.peerId) {
        break;
      }

      const leaving = state.participantViews.get(message.peerId);
      const leavingName = leaving ? leaving.name : '참석자';

      closePeerConnection(message.peerId);
      removeParticipant(message.peerId);
      addLog(`${leavingName}님이 퇴장했습니다.`);
      break;
    }

    case 'room-state': {
      if (Array.isArray(message.participants)) {
        const incomingIds = new Set(message.participants.map((p) => p.id));

        for (const peer of message.participants) {
          if (peer.id === state.localId) {
            const me = state.participantViews.get(peer.id);
            if (me) {
              me.updateName(state.displayName);
            }
            continue;
          }

          addOrUpdateParticipant({ id: peer.id, isLocal: false, name: peer.name });
        }

        for (const [id, view] of state.participantViews.entries()) {
          if (view.isLocal) {
            continue;
          }
          if (!incomingIds.has(id)) {
            closePeerConnection(id);
            removeParticipant(id);
          }
        }
      }

      updateCapacity(message.count, message.maxParticipants || 3);
      break;
    }

    case 'signal': {
      try {
        await handleSignalMessage(message);
      } catch (error) {
        console.error('Signal handling error:', error);
      }
      break;
    }

    case 'room-full': {
      setJoinMessage(`회의실 인원이 가득 찼습니다. 최대 ${message.maxParticipants || 3}명까지 입장할 수 있습니다.`);
      setConnectionStatus('정원 초과');
      break;
    }

    case 'error': {
      const reason = message.reason || 'unknown';
      setJoinMessage(`오류: ${reason}`);
      addLog(`서버 오류(${reason})`);
      break;
    }

    default:
      break;
  }
}

function connectSocketAndJoin(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getSocketUrl());
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch (_error) {
          // no-op
        }
        reject(makeCodeError('JOIN_TIMEOUT'));
      }
    }, timeoutMs);

    state.ws = ws;

    ws.onopen = () => {
      setConnectionStatus('서버 연결중');
      ws.send(
        JSON.stringify({
          type: 'join',
          roomId: state.roomId,
          name: state.displayName,
        }),
      );
    };

    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_error) {
        return;
      }

      if (!settled && message.type === 'joined') {
        settled = true;
        window.clearTimeout(timeoutId);
        resolve();
      }

      if (!settled && message.type === 'room-full') {
        settled = true;
        window.clearTimeout(timeoutId);
        reject(new Error('ROOM_FULL'));
      }

      await handleServerMessage(message);
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeoutId);
        reject(makeCodeError('WS_ERROR'));
      }
      setConnectionStatus('연결 오류');
    };

    ws.onclose = () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeoutId);
        reject(makeCodeError('WS_CLOSED'));
      }

      if (state.intentionalLeave) {
        return;
      }

      if (state.joined) {
        setConnectionStatus('연결 종료');
        addLog('서버 연결이 종료되었습니다. 다시 참석해주세요.');
      }
    };
  });
}

function waitMs(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function connectSocketAndJoinWithRetry() {
  const attempts = [12000, 30000];
  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    try {
      await connectSocketAndJoin(attempts[i]);
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code || String(error?.message || '');
      const retryable = code === 'JOIN_TIMEOUT' || code === 'WS_ERROR' || code === 'WS_CLOSED';
      const canRetry = i < attempts.length - 1;

      if (!retryable || !canRetry) {
        throw error;
      }

      setJoinMessage('서버를 깨우는 중입니다. 자동으로 다시 연결합니다...');
      await waitMs(900);
    }
  }

  throw lastError || makeCodeError('WS_ERROR');
}

function getDefaultVideoConstraints() {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24, max: 30 },
  };
}

function isRecoverableMediaError(error) {
  if (!error) {
    return false;
  }
  if (error.code === 'MEDIA_TIMEOUT') {
    return true;
  }
  return ['NotReadableError', 'NotFoundError', 'OverconstrainedError', 'AbortError'].includes(error.name);
}

function getMediaWithTimeout(constraints, timeoutMs) {
  const mediaPromise = navigator.mediaDevices.getUserMedia(constraints);
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(makeCodeError('MEDIA_TIMEOUT'));
    }, timeoutMs);
  });

  return Promise.race([mediaPromise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
  });
}

async function prepareLocalStream() {
  if (state.localStream) {
    return state.localStream;
  }

  const video = getDefaultVideoConstraints();

  try {
    const stream = await getMediaWithTimeout({ audio: true, video }, 9000);
    state.localStream = stream;
    state.cameraTrackBeforeShare = getStreamVideoTrack(stream);
    state.mediaMode = 'audio-video';
    return stream;
  } catch (primaryError) {
    if (!isRecoverableMediaError(primaryError)) {
      throw primaryError;
    }

    try {
      const videoOnlyStream = await getMediaWithTimeout({ audio: false, video }, 7000);
      state.localStream = videoOnlyStream;
      state.cameraTrackBeforeShare = getStreamVideoTrack(videoOnlyStream);
      state.mediaMode = 'video-only';
      return videoOnlyStream;
    } catch (videoOnlyError) {
      if (!isRecoverableMediaError(videoOnlyError)) {
        throw primaryError;
      }

      try {
        const audioOnlyStream = await getMediaWithTimeout({ audio: true, video: false }, 7000);
        state.localStream = audioOnlyStream;
        state.cameraTrackBeforeShare = null;
        state.mediaMode = 'audio-only';
        return audioOnlyStream;
      } catch (_audioOnlyError) {
        // Allow join without local media when devices are occupied/unavailable.
        const emptyStream = new MediaStream();
        state.localStream = emptyStream;
        state.cameraTrackBeforeShare = null;
        state.mediaMode = 'none';
        return emptyStream;
      }
    }
  }
}

function syncMediaButtons() {
  const stream = state.localStream;
  state.virtualEnabled = false;

  if (!stream) {
    elements.audioBtn.disabled = false;
    elements.videoBtn.disabled = false;
    updateToggleButton(elements.audioBtn, '마이크 켜짐', '마이크 꺼짐', true);
    updateToggleButton(elements.videoBtn, '카메라 켜짐', '카메라 꺼짐', true);
    syncShareButton();
    syncZoomButtons();
    return;
  }

  const audioTrack = stream.getAudioTracks()[0] || null;
  const videoTrack = stream.getVideoTracks()[0] || null;

  if (audioTrack) {
    elements.audioBtn.disabled = false;
    updateToggleButton(elements.audioBtn, '마이크 켜짐', '마이크 꺼짐', audioTrack.enabled);
  } else {
    elements.audioBtn.disabled = true;
    elements.audioBtn.textContent = '마이크 없음';
    elements.audioBtn.classList.remove('active');
  }

  if (videoTrack) {
    elements.videoBtn.disabled = false;
    updateToggleButton(elements.videoBtn, '카메라 켜짐', '카메라 꺼짐', videoTrack.enabled);
  } else {
    elements.videoBtn.disabled = true;
    elements.videoBtn.textContent = '카메라 없음';
    elements.videoBtn.classList.remove('active');
  }

  syncShareButton();
  syncZoomButtons();
}

function updateMediaModeFromLocalTracks() {
  const hasAudio = Boolean(state.localStream && state.localStream.getAudioTracks().length);
  const hasVideo = Boolean(state.localStream && state.localStream.getVideoTracks().length);
  if (hasAudio && hasVideo) {
    state.mediaMode = 'audio-video';
  } else if (hasVideo) {
    state.mediaMode = 'video-only';
  } else if (hasAudio) {
    state.mediaMode = 'audio-only';
  } else {
    state.mediaMode = 'none';
  }
}

function startRenderLoop() {
  if (state.renderFrameId) {
    return;
  }

  const tick = (now) => {
    for (const view of state.participantViews.values()) {
      view.draw(now);
    }
    state.renderFrameId = window.requestAnimationFrame(tick);
  };

  state.renderFrameId = window.requestAnimationFrame(tick);
}

function stopRenderLoop() {
  if (!state.renderFrameId) {
    return;
  }

  window.cancelAnimationFrame(state.renderFrameId);
  state.renderFrameId = null;
}

function updateToggleButton(button, activeText, inactiveText, isActive) {
  button.textContent = isActive ? activeText : inactiveText;
  button.classList.toggle('active', isActive);
}

function toggleAudio() {
  if (!state.localStream) {
    return;
  }

  const tracks = state.localStream.getAudioTracks();
  if (!tracks.length) {
    setJoinMessage('현재 마이크 장치를 사용할 수 없습니다.');
    return;
  }

  const next = !tracks[0].enabled;
  tracks.forEach((track) => {
    track.enabled = next;
  });
  updateToggleButton(elements.audioBtn, '마이크 켜짐', '마이크 꺼짐', next);
}

function toggleVideo() {
  if (!state.localStream) {
    return;
  }

  if (state.isScreenSharing) {
    setJoinMessage('화면공유 중에는 화면공유 중지를 눌러 먼저 종료해주세요.');
    return;
  }

  const tracks = state.localStream.getVideoTracks();
  if (!tracks.length) {
    setJoinMessage('현재 카메라 장치를 사용할 수 없습니다.');
    return;
  }

  const next = !tracks[0].enabled;
  tracks.forEach((track) => {
    track.enabled = next;
  });
  updateMediaModeFromLocalTracks();
  updateToggleButton(elements.videoBtn, '카메라 켜짐', '카메라 꺼짐', next);
}

async function startScreenShare() {
  if (!canShareScreen()) {
    setJoinMessage('현재 기기/브라우저에서는 화면공유를 지원하지 않습니다.');
    return;
  }

  if (!state.joined) {
    setJoinMessage('회의 입장 후 화면공유가 가능합니다.');
    return;
  }

  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: 15, max: 30 } },
    });
    const screenTrack = getStreamVideoTrack(screenStream);
    if (!screenTrack) {
      setJoinMessage('화면공유 비디오 트랙을 찾지 못했습니다.');
      return;
    }

    const currentTrack = getStreamVideoTrack(state.localStream);
    if (currentTrack && !isScreenTrack(currentTrack)) {
      state.cameraTrackBeforeShare = currentTrack;
    }

    state.isScreenSharing = true;
    state.screenStream = screenStream;
    state.screenShareStopHandler = () => {
      stopScreenShare(true).catch((error) => {
        console.error('Stop screen share failed:', error);
      });
    };
    screenTrack.addEventListener('ended', state.screenShareStopHandler, { once: true });

    if (!state.localStream) {
      state.localStream = new MediaStream();
    }

    for (const track of state.localStream.getVideoTracks()) {
      if (track.id !== screenTrack.id) {
        state.localStream.removeTrack(track);
      }
    }
    if (!state.localStream.getVideoTracks().some((track) => track.id === screenTrack.id)) {
      state.localStream.addTrack(screenTrack);
    }

    await replaceOutgoingVideoTrack(screenTrack);
    updateMediaModeFromLocalTracks();
    syncLocalPreview();
    syncMediaButtons();
    addLog('화면공유를 시작했습니다.');
  } catch (error) {
    console.error('Screen share start failed:', error);
    setJoinMessage('화면공유를 시작하지 못했습니다. 브라우저 권한 또는 기기 설정을 확인해주세요.');
    state.isScreenSharing = false;
    state.screenStream = null;
    state.screenShareStopHandler = null;
    syncMediaButtons();
  }
}

async function stopScreenShare(fromEnded = false) {
  if (!state.isScreenSharing) {
    return;
  }

  const stream = state.screenStream;
  const screenTrack = getStreamVideoTrack(stream);

  if (screenTrack && state.screenShareStopHandler) {
    try {
      screenTrack.removeEventListener('ended', state.screenShareStopHandler);
    } catch (_error) {
      // no-op
    }
  }

  state.isScreenSharing = false;
  state.screenShareStopHandler = null;
  state.screenStream = null;

  if (stream) {
    for (const track of stream.getTracks()) {
      if (!fromEnded || track.readyState === 'live') {
        track.stop();
      }
    }
  }

  let restoreTrack = null;
  if (state.cameraTrackBeforeShare && state.cameraTrackBeforeShare.readyState === 'live') {
    restoreTrack = state.cameraTrackBeforeShare;
  }

  if (!state.localStream) {
    state.localStream = new MediaStream();
  }

  for (const track of state.localStream.getVideoTracks()) {
    state.localStream.removeTrack(track);
  }

  if (restoreTrack) {
    state.localStream.addTrack(restoreTrack);
  }

  await replaceOutgoingVideoTrack(restoreTrack);
  updateMediaModeFromLocalTracks();
  syncLocalPreview();
  syncMediaButtons();
  addLog(restoreTrack ? '화면공유를 종료하고 카메라로 복귀했습니다.' : '화면공유를 종료했습니다.');
}

async function toggleVirtual() {
  if (state.isScreenSharing) {
    await stopScreenShare(false);
    return;
  }
  await startScreenShare();
}

function resetStateAfterLeave() {
  const activeScreenStream = state.screenStream;
  closeFocusView();

  state.joined = false;
  state.localId = null;
  state.mediaMode = 'none';
  state.localViewZoom = MIN_LOCAL_VIEW_ZOOM;
  state.roomId = '';
  state.displayName = '';
  state.joinCounter = 0;
  state.focusParticipantId = null;
  state.isScreenSharing = false;
  state.screenShareStopHandler = null;
  state.screenStream = null;
  state.virtualEnabled = false;

  closeAllPeerConnections();

  for (const view of state.participantViews.values()) {
    view.destroy();
  }
  state.participantViews.clear();

  stopRenderLoop();

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      track.stop();
    }
  }
  if (activeScreenStream) {
    for (const track of activeScreenStream.getTracks()) {
      track.stop();
    }
  }
  if (state.cameraTrackBeforeShare && state.cameraTrackBeforeShare.readyState === 'live') {
    state.cameraTrackBeforeShare.stop();
  }
  state.localStream = null;
  state.cameraTrackBeforeShare = null;

  layoutSeats();
  updateParticipantList();
  updateCapacity(0, 3);
  syncMediaButtons();
}

function cleanupFailedJoin() {
  state.intentionalLeave = true;

  if (state.ws) {
    try {
      state.ws.close();
    } catch (_error) {
      // no-op
    }
  }
  state.ws = null;

  resetStateAfterLeave();
  elements.meetingView.classList.add('hidden');
  elements.joinView.classList.remove('hidden');
  state.intentionalLeave = false;
}

function leaveMeeting(sendMessage = true) {
  state.intentionalLeave = true;

  if (state.ws) {
    if (sendMessage && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'leave' }));
    }

    try {
      state.ws.close();
    } catch (_error) {
      // no-op
    }
  }
  state.ws = null;

  resetStateAfterLeave();

  elements.meetingView.classList.add('hidden');
  elements.joinView.classList.remove('hidden');
  setConnectionStatus('대기중');
  syncMediaButtons();

  setTimeout(() => {
    state.intentionalLeave = false;
  }, 50);
}

async function joinMeeting(event) {
  event.preventDefault();

  if (state.joined) {
    return;
  }

  state.displayName = sanitizeName(elements.nameInput.value);
  state.roomId = sanitizeRoom(elements.roomInput.value);

  elements.nameInput.value = state.displayName;
  elements.roomInput.value = state.roomId;
  setJoinMessage('카메라와 마이크를 준비중입니다...');
  setConnectionStatus('준비중');
  elements.joinBtn.disabled = true;

  try {
    await prepareLocalStream();
    syncMediaButtons();
    if (state.mediaMode === 'video-only') {
      setJoinMessage('마이크를 사용할 수 없어 카메라 전용으로 연결중입니다...');
    } else if (state.mediaMode === 'audio-only') {
      setJoinMessage('카메라를 사용할 수 없어 음성 전용으로 연결중입니다...');
    } else if (state.mediaMode === 'none') {
      setJoinMessage('카메라/마이크 없이 관전자 모드로 연결중입니다...');
    } else {
      setJoinMessage('회의 서버에 연결중입니다...');
    }
    await connectSocketAndJoinWithRetry();
    setJoinMessage('');
  } catch (error) {
    console.error(error);
    const code = error?.code || String(error?.message || '');
    if (code === 'ROOM_FULL') {
      cleanupFailedJoin();
      setJoinMessage('회의실 정원이 가득 찼습니다.');
      setConnectionStatus('정원 초과');
    } else if (code === 'WS_ERROR' || code === 'WS_CLOSED' || code === 'JOIN_TIMEOUT') {
      cleanupFailedJoin();
      setJoinMessage('회의 서버 연결이 지연됩니다. 페이지 새로고침 후 다시 시도해주세요.');
      setConnectionStatus('연결 실패');
    } else if (code === 'MEDIA_TIMEOUT') {
      cleanupFailedJoin();
      setJoinMessage('카메라/마이크 접근이 지연됩니다. 다른 화상앱 점유 여부를 확인해주세요.');
      setConnectionStatus('장치 확인');
    } else if (error && error.name === 'NotAllowedError') {
      cleanupFailedJoin();
      setJoinMessage('카메라/마이크 권한이 차단되었습니다. 주소창 권한 설정에서 허용해주세요.');
      setConnectionStatus('권한 필요');
    } else if (error && error.name === 'NotReadableError') {
      cleanupFailedJoin();
      setJoinMessage('카메라 또는 마이크가 다른 앱에서 사용 중입니다. 다른 앱을 종료 후 다시 시도해주세요.');
      setConnectionStatus('장치 사용중');
    } else if (error && error.name === 'NotFoundError') {
      cleanupFailedJoin();
      setJoinMessage('사용 가능한 카메라/마이크 장치를 찾지 못했습니다.');
      setConnectionStatus('장치 없음');
    } else {
      cleanupFailedJoin();
      setJoinMessage('카메라 또는 마이크 권한을 확인해주세요.');
      setConnectionStatus('권한 필요');
    }
  } finally {
    elements.joinBtn.disabled = false;
  }
}

function makeCodeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function bindEvents() {
  elements.joinForm.addEventListener('submit', joinMeeting);
  elements.audioBtn.addEventListener('click', toggleAudio);
  elements.videoBtn.addEventListener('click', toggleVideo);
  elements.virtualBtn.addEventListener('click', () => {
    toggleVirtual().catch((error) => {
      console.error('Screen share toggle failed:', error);
    });
  });
  if (elements.zoomOutBtn) {
    elements.zoomOutBtn.addEventListener('click', () => zoomLocalView(-LOCAL_VIEW_ZOOM_STEP));
  }
  if (elements.zoomInBtn) {
    elements.zoomInBtn.addEventListener('click', () => zoomLocalView(LOCAL_VIEW_ZOOM_STEP));
  }
  elements.leaveBtn.addEventListener('click', () => leaveMeeting(true));
  if (elements.seatGrid) {
    elements.seatGrid.addEventListener('dblclick', handleSeatDoubleClick);
  }
  if (elements.focusCloseBtn) {
    elements.focusCloseBtn.addEventListener('click', closeFocusView);
  }
  if (elements.focusOverlay) {
    elements.focusOverlay.addEventListener('click', (event) => {
      if (event.target === elements.focusOverlay) {
        closeFocusView();
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'leave' }));
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.focusParticipantId) {
      closeFocusView();
    }
  });
}

function bootstrap() {
  layoutSeats();
  updateParticipantList();
  updateCapacity(0, 3);
  setConnectionStatus('대기중');
  syncMediaButtons();
  bindEvents();
}

bootstrap();
