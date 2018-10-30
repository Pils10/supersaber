import {BEAT_WARMUP_OFFSET, BEAT_WARMUP_SPEED, BEAT_WARMUP_TIME} from '../constants/beat';
import utils from '../utils';

/**
 * Load beat data (all the beats and such).
 */
AFRAME.registerComponent('beat-loader', {
  dependencies: ['stage-colors'],
  schema: {
    beatAnticipationTime: {default: 2.0},
    beatSpeed: {default: 4.0},
    challengeId: {type: 'string'},  // If clicked play.
    difficulty: {type: 'string'},
    isPlaying: {default: false},
    menuSelectedChallengeId: {type: 'string'}  // If menu selected.
  },

  orientations: [180, 0, 270, 90, 225, 135, 315, 45, 0],
  orientationsHumanized: {
    0: 'down',
    45: 'downright',
    90: 'right',
    135: 'upright',
    180: 'up',
    225: 'upleft',
    270: 'left',
    315: 'downleft'
  },
  horizontalPositions: [-0.60, -0.25, 0.25, 0.60],
  verticalPositions: [1.00, 1.35, 1.70],

  init: function () {
    this.audioAnalyserEl = document.getElementById('audioanalyser');
    this.beatData = null;
    this.beatDataProcessed = false;
    this.beatContainer = document.getElementById('beatContainer');
    this.beatsTime = undefined;
    this.beatsTimeOffset = undefined;
    this.bpm = undefined;
    this.songCurrentTime = undefined;
    this.onKeyDown = this.onKeyDown.bind(this);
    this.xhr = null;

    this.stageColors = this.el.components['stage-colors'];
    this.twister = document.getElementById('twister');
    this.leftStageLasers = document.getElementById('leftStageLasers');
    this.rightStageLasers = document.getElementById('rightStageLasers');

    this.el.addEventListener('cleargame', this.clearBeats.bind(this));

    // this.addDebugControls();
  },

  update: function (oldData) {
    const data = this.data;

    // Start playing.
    if (!oldData.challengeId && data.challengeId && this.beatData) {
      this.processBeats();
      return;
    }

    if (!data.menuSelectedChallengeId || !data.difficulty) { return; }

    // Prefetch beats.
    if (data.menuSelectedChallengeId !== oldData.menuSelectedChallengeId ||
        data.difficulty !== oldData.difficulty) {
      this.fetchBeats();
    }
  },

  play: function () {
    window.addEventListener('keydown', this.onKeyDown);
  },

  pause: function () {
    window.removeEventListener('keydown', this.onKeyDown);
  },

  /**
   * XHR. Beat data is prefetched when user selects a menu challenge, and stored away
   * to be processed later.
   */
  fetchBeats: function () {
    var el = this.el;

    if (this.xhr) { this.xhr.abort(); }

    // Load beats.
    let url = utils.getS3FileUrl(this.data.menuSelectedChallengeId,
                                 `${this.data.difficulty}.json`);
    const xhr = this.xhr = new XMLHttpRequest();
    el.emit('beatloaderstart');
    console.log(`[beat-loader] Fetching ${url}...`);
    xhr.open('GET', url);
    xhr.addEventListener('load', () => {
      this.beatData = JSON.parse(xhr.responseText);
      this.beatDataProcessed = false;
      this.xhr = null;
      this.el.sceneEl.emit('beatloaderfinish', null, false);
    });
    xhr.send();
  },

  /**
   * Load the beat data into the game.
   */
  processBeats: function () {
    // Reset variables used during playback.
    // Beats spawn ahead of the song and get to the user in sync with the music.
    this.beatsTimeOffset = this.data.beatAnticipationTime * 1000;
    this.beatsTime = 0;
    this.beatData._events.sort(lessThan);
    this.beatData._obstacles.sort(lessThan);
    this.beatData._notes.sort(lessThan);
    this.bpm = this.beatData._beatsPerMinute;

    // Some events have negative time stamp to initialize the stage.
    const events = this.beatData._events;
    if (events.length && events[0]._time < 0) {
      for (let i = 0; events[i]._time < 0; i++) {
        this.generateEvent(events[i]);
      }
    }

    this.beatDataProcessed = true;
    console.log('[beat-loader] Finished processing beat data.');
  },

  /**
   * Generate beats and stuff according to timestamp.
   */
  tick: function (time, delta) {
    var i;
    var noteTime;

    if (!this.data.isPlaying || !this.data.challengeId || !this.beatData) { return; }

    // Re-sync song with beats playback.
    const songComponent = this.el.components.song;
    const currentTime = songComponent.getCurrentTime();

    if (currentTime !== undefined && this.beatsTimeOffset !== undefined &&
        this.songCurrentTime !== currentTime) {
      this.songCurrentTime = currentTime;
      this.beatsTime = (this.songCurrentTime + this.data.beatAnticipationTime) * 1000;
    }

    const beatsTime = this.beatsTime;
    const bpm = this.beatData._beatsPerMinute;
    const msPerBeat = 1000 * 60 / this.beatData._beatsPerMinute;

    const notes = this.beatData._notes;
    for (i = 0; i < notes.length; ++i) {
      noteTime = notes[i]._time * msPerBeat;
      if (noteTime > (beatsTime - BEAT_WARMUP_TIME) &&
          noteTime <= (beatsTime - BEAT_WARMUP_TIME + delta)) {
        notes[i].time = noteTime;
        this.generateBeat(notes[i]);
      }
    }

    const obstacles = this.beatData._obstacles;
    for (i = 0; i < obstacles.length; ++i) {
      noteTime = obstacles[i]._time * msPerBeat;
      if (noteTime > beatsTime && noteTime <= beatsTime + delta) {
        this.generateWall(obstacles[i]);
      }
    }

    const events = this.beatData._events;
    for (i=0; i < events.length; ++i) {
      noteTime = events[i]._time * msPerBeat;
      if (noteTime > beatsTime && noteTime <= beatsTime + delta) {
        this.generateEvent(events[i]);
      }
    }

    // Update preload beat offset.
    if (this.beatsTimeOffset !== undefined) {
      if (this.beatsTimeOffset <= 0) {
        this.el.sceneEl.emit('beatloaderpreloadfinish', null, false);
        this.songCurrentTime = songComponent.getCurrentTime();
        this.beatsTimeOffset = undefined;
      } else {
        this.beatsTimeOffset -= delta;
      }
    }

    this.beatsTime += delta;
  },

  generateBeat: (function () {
    const beatObj = {};
    // Beats arrive at sword stroke distance synced with the music.
    const swordOffset = 1.5;

    return function (noteInfo) {
      var beatEl;
      var color;

      // if (Math.random() < 0.8) noteInfo._type = 3; // just to DEBUG MINES!

      var type = noteInfo._cutDirection === 8 ? 'dot' : 'arrow';

      color = noteInfo._type === 0 ? 'red' : 'blue';
      if (noteInfo._type === 3) {
        type = 'mine';
        color = undefined;
      }
      beatEl = this.requestBeat(type, color);
      if (!beatEl) { return; }

      beatObj.color = color;
      beatObj.cutDirection =
        this.orientationsHumanized[this.orientations[noteInfo._cutDirection]];
      beatObj.speed = this.data.beatSpeed;
      beatObj.type = type;
      beatEl.setAttribute('beat', beatObj);
      beatEl.object3D.position.set(
        this.horizontalPositions[noteInfo._lineIndex],
        this.verticalPositions[noteInfo._lineLayer],
        -this.data.beatAnticipationTime * this.data.beatSpeed - swordOffset
      );
      beatEl.object3D.rotation.z = THREE.Math.degToRad(
        this.orientations[noteInfo._cutDirection]);

      beatEl.play();
      beatEl.components.beat.onGenerate();
    };
  })(),

  generateWall: function (wallInfo) {
    var el = this.el.sceneEl.components.pool__wall.requestEntity();
    var speed = this.data.beatSpeed;

    if (!el) { return; }

    const durationSeconds = 60 * (wallInfo._duration / this.bpm);
    el.setAttribute('wall', 'speed', speed);
    el.object3D.position.set(
      this.horizontalPositions[wallInfo._lineIndex],
      1.30,
      -(this.data.beatAnticipationTime * speed)
    );
    el.object3D.scale.set(wallInfo._width * 0.30, 2.5, durationSeconds * speed);
    el.play();
  },

  generateEvent: function (event) {
    switch(event._type) {
      case 0:
        this.stageColors.setColor('fog', event._value);
        this.stageColors.setColor('sky', event._value);
        this.stageColors.setColor('backglow', event._value);
        break;
      case 1:
        this.stageColors.setColor('tunnelNeon', event._value);
        break;
      case 2:
        this.stageColors.setColor('leftStageLaser0', event._value);
        this.stageColors.setColor('leftStageLaser1', event._value);
        this.stageColors.setColor('leftStageLaser2', event._value);
        break;
      case 3:
        this.stageColors.setColor('rightStageLaser0', event._value);
        this.stageColors.setColor('rightStageLaser1', event._value);
        this.stageColors.setColor('rightStageLaser2', event._value);
        break;
      case 4:
        this.stageColors.setColor('floor', event._value);
        this.stageColors.setColor('stageNeon', event._value);
        break;
      case 8:
        this.twister.components.twister.pulse(event._value);
        break;
      case 9:
        // zoom was a bit disturbing
        this.twister.components.twister.pulse(event._value);
        break;
      case 12:
        this.leftStageLasers.components['stage-lasers'].pulse(event._value);
        break;
      case 13:
        this.rightStageLasers.components['stage-lasers'].pulse(event._value);
        break;
    }
  },

  requestBeat: function (type, color) {
    var beatPoolName = 'pool__beat-' + type;
    var pool;
    if (color) { beatPoolName += '-' + color; }
    pool = this.el.sceneEl.components[beatPoolName];
    if (!pool) {
      console.warn('Pool ' + beatPoolName + ' unavailable');
      return;
    }
    return pool.requestEntity();
  },

  /**
   * Restart by returning all beats to pool.
   */
  clearBeats: function () {
    this.beatsTime = 0;
    this.beatsTimeOffset = this.data.beatAnticipationTime * 1000;
    for (let i = 0; i < this.beatContainer.children.length; i++) {
      let child = this.beatContainer.children[i];
      if (child.components.beat) {
        child.components.beat.returnToPool(true);
      }
      if (child.components.wall) {
        child.components.wall.returnToPool(true);
      }
    }
  },

  addDebugControls: function () {
    var self = this;
    var currControl = 0;

    function addControl (i, name, type) {
      var div = document.createElement('div');
      div.style.position = 'absolute';
      div.id = 'stagecontrol' + i;
      div.style.width = '100px';
      div.style.height = '30px';
      div.style.top = type === 'element' ? '20px' : '70px';
      div.style.background = '#000';
      div.style.color = '#fff';
      div.style.zIndex = 999999999;
      div.style.padding = '5px';
      div.style.font = '14px sans-serif';
      div.style.textAlign = 'center';
      div.style.cursor = 'pointer';
      div.style.left = (20 + i * 120)+'px';
      div.innerHTML = name;
      if (type === 'element') {
        div.addEventListener('click', () => {
          document.getElementById('stagecontrol' + currControl).style.background = '#000';
          div.style.background = '#66f';
          currControl = i;
        });
      } else {
        div.addEventListener('click', () => {
          self.generateEvent({_type: currControl, _value: i})
        })
      }
      document.body.appendChild(div);
    }

    [
      'sky',
      'tunnelNeon',
      'leftStageLasers',
      'rightStageLasers',
      'floor'
    ].forEach((id, i) => { addControl(i, id, 'element'); });

    [
      'off',
      'blue',
      'blue',
      'bluefade',
      '',
      'red',
      'red',
      'redfade'
    ].forEach((id, i) => { addControl(i, id, 'value'); });
  },

  /**
   * Debug generate beats.
   */
  onKeyDown: function (event) {
    const keyCode = event.keyCode;
    switch (keyCode) {
      case 32:  // Space.
        this.generateBeat({
          _lineIndex: 2,
          _lineLayer: 1,
          _cutDirection: 1,
          _type: 1
        });
        break;
      default:
        break;
    }
  }
});

function lessThan (a, b) { return a._time - b._time; }
