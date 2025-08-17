// packages/@schmooky/pixi-rive/src/index.ts
import {
  Sprite,
  Texture,
  TextureSource,
  Ticker,
  Container, // exported for convenience (see note below)
  Graphics,  // exported for convenience (see note below)
} from 'pixi.js';

import { Rive, RuntimeLoader } from '@rive-app/canvas';

RuntimeLoader.setWasmUrl('/rive.wasm');

export type RiveSpriteOptions = {
  /** URL to a .riv file (e.g. '/vehicles.riv' under your app's public folder) */
  src: string;
  /** Autoplay the default animation (if present). Default: true */
  autoplay?: boolean;
  /** Logical display size (width == height). Default: 512 */
  size?: number;
  /** Enable pointer events; you can listen via .on('pointerdown', ...) */
  interactive?: boolean;
  /** Enable verbose console logs. Default: true */
  debug?: boolean;
};

export class RiveSprite extends Sprite {
  private _rive?: Rive;
  private _canvas!: HTMLCanvasElement;

  private _ticker?: Ticker;
  private _tick = (t: Ticker) => this.update(t.elapsedMS);

  private _src: string;
  private _autoplay: boolean;
  private _size: number;
  private _dpr: number;
  private _ready = false;
  private _destroyed = false;
  private _didFirstUpload = false;
  private _debug = true;

  private TAG = '[RiveSprite]';

  constructor(opts: RiveSpriteOptions) {
    // config
    const size = opts.size ?? 512;
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    // backing canvas (DPR-aware)
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.floor(size * dpr));
    canvas.height = Math.max(2, Math.floor(size * dpr));

    // wrap canvas as Pixi texture
    const texture = Texture.from(canvas);
    super({ texture });

    this._src = opts.src;
    this._autoplay = opts.autoplay ?? true;
    this._size = size;
    this._dpr = dpr;
    this._debug = opts.debug ?? true;
    this._canvas = canvas;

    // keep logical display size equal to `size`
    this.scale.set(1 / dpr);

    // optional pointer events
    if (opts.interactive) {
      this.eventMode = 'static';
      this.cursor = 'pointer';
    }

    this.log('ctor', {
      size: this._size,
      dpr: this._dpr,
      canvas: { w: canvas.width, h: canvas.height },
      autoplay: this._autoplay,
      src: this._src,
    });

    // async init
    this.init().catch((err) => this.error('init() failed', err));
  }

  /** True after the file is loaded and first frame uploaded. */
  get isReady() {
    return this._ready;
  }

  /** Change the .riv source at runtime. */
  async setSource(src: string) {
    this.log('setSource', { from: this._src, to: src });
    this._src = src;
    await this.initRive();
  }

  /** Pause playback (keeps last frame). */
  pause() {
    this.log('pause');
    this._autoplay = false;
    if (this._rive) (this._rive as any).pause?.();
  }

  /** Resume playback. */
  play() {
    this.log('play');
    this._autoplay = true;
    if (this._rive) (this._rive as any).play?.();
  }

  /** Start ticker-driven updates (auto-called after init). */
  enable() {
    this.log('enable');
    if (!this._ticker) {
      // Use system ticker so it stays in lockstep with Application
      this._ticker = Ticker.system;
      this._ticker.add(this._tick);
      this.log('enable.ticker.added', { systemTicker: true });
    }
  }

  /** Stop updates (keeps last uploaded frame). */
  disable() {
    this.log('disable');
    if (this._ticker) {
      this._ticker.remove(this._tick);
      this._ticker = undefined;
      this.log('disable.ticker.removed');
    }
  }

  /** Pixi lifecycle: clean up runtime and ticker. */
  destroy(options?: boolean) {
    this.log('destroy.begin', { options });
    if (this._destroyed) {
      this.warn('destroy.called_twice');
      return;
    }
    this._destroyed = true;

    this.disable();

    try {
      this._rive?.cleanup();
      this.log('destroy.rive.cleanup_ok');
    } catch (e) {
      this.warn('destroy.rive.cleanup_error', e);
    }

    super.destroy(options);
    this.log('destroy.end');
  }

  // ----------------- Internals -----------------

  private async init() {
    this.log('init.start');
    await this.initRive();
    this.enable();
    this.log('init.end', { ready: this._ready });
  }

  private async initRive() {
    this._ready = false;
    this._didFirstUpload = false;

    const src = this._src;
    this.log('initRive.start', { src });

    // Fetch the .riv bytes
    let bytes: ArrayBuffer;
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${src}`);
      bytes = await resp.arrayBuffer();
      this.log('initRive.fetch.ok', { size: bytes.byteLength });
    } catch (e) {
      this.error('initRive.fetch.failed', e);
      throw e;
    }

    // Dispose previous runtime if present
    try {
      if (this._rive) {
        (this._rive as any).pause?.();
        this._rive.cleanup();
        this.log('initRive.old.cleanup_ok');
      }
    } catch (e) {
      this.warn('initRive.old.cleanup_error', e);
    }

    // Create the runtime bound to our canvas
    try {
      this._rive = new Rive({
        buffer: bytes,
        canvas: this._canvas,
        autoplay: this._autoplay,
      });
      this.log('initRive.rive.created', { autoplay: this._autoplay });
    } catch (e) {
      this.error('initRive.rive.create_failed', e);
      throw e;
    }

    // Force-first upload so something is visible immediately
    try {
      const ts = this.texture?.source as TextureSource | any;
      if (ts && typeof ts.update === 'function') {
        ts.update();
        this._didFirstUpload = true;
        this.log('initRive.texture.first_upload_ok');
      } else {
        this.warn('initRive.texture.no_update_method');
      }
    } catch (e) {
      this.warn('initRive.texture.first_upload_error', e);
    }

    this._ready = true;
    this.log('initRive.end', { ready: this._ready });
  }

  /** Called every frame by Pixi’s ticker. */
  private update(deltaMS: number) {
    if (!this._rive) {
      this.debug('update.skip.no_rive');
      return;
    }
    if (!this._ticker) {
      this.debug('update.skip.no_ticker');
      return;
    }

    // Rive (canvas runtime) draws into our canvas; we just need to mark the Pixi
    // CanvasSource as dirty so it uploads fresh pixels to the GPU.
    try {
      const ts = this.texture?.source as TextureSource | any;
      if (ts && typeof ts.update === 'function') {
        ts.update();
        if (!this._didFirstUpload) {
          this._didFirstUpload = true;
          this.log('update.first_upload_seen');
        }
      } else {
        this.warn('update.texture.no_update_method');
      }
    } catch (e) {
      this.warn('update.texture.upload_error', e);
    }
  }

  // ----------------- Logging helpers -----------------

  private log(msg: string, extra?: unknown) {
    if (!this._debug) return;
    // eslint-disable-next-line no-console
    console.info(`${this.TAG} ${msg}`, extra ?? '');
  }

  private debug(msg: string, extra?: unknown) {
    if (!this._debug) return;
    // eslint-disable-next-line no-console
    console.debug(`${this.TAG} ${msg}`, extra ?? '');
  }

  private warn(msg: string, extra?: unknown) {
    if (!this._debug) return;
    // eslint-disable-next-line no-console
    console.warn(`${this.TAG} ${msg}`, extra ?? '');
  }

  private error(msg: string, extra?: unknown) {
    // eslint-disable-next-line no-console
    console.error(`${this.TAG} ${msg}`, extra ?? '');
  }
}

export default RiveSprite;
