import {
  Sprite,
  Texture,
  CanvasSource,
  Ticker,
} from 'pixi.js';
import { Rive, RuntimeLoader } from '@rive-app/canvas';

RuntimeLoader.setWasmUrl('/rive.wasm');

export type RiveSpriteOptions = {
  src: string;        // .riv URL
  autoplay?: boolean; // default true
  size?: number;      // logical size; backing store uses DPR
  interactive?: boolean;
  debug?: boolean;    // default true
};

export class RiveSprite extends Sprite {
  private _rive?: Rive;

  // Rive draws into this (no DOM sizing)
  private _off!: OffscreenCanvas;

  // Pixi uploads from this (stays constant → no source swapping)
  private _disp!: HTMLCanvasElement;
  private _dispCtx!: CanvasRenderingContext2D;
  private _dispSrc!: CanvasSource; // Pixi v8 CanvasSource wrapping _disp

  private _ticker?: Ticker;
  private _tick = (ticker: Ticker) => this.update(ticker.elapsedMS);

  private _src: string;
  private _autoplay: boolean;
  private _size: number;
  private _dpr: number;
  private _ready = false;
  private _destroyed = false;
  private _debug = true;

  private TAG = '[RiveSprite]';

  constructor(opts: RiveSpriteOptions) {
    const size = opts.size ?? 512;
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    const W = Math.max(2, Math.floor(size * dpr));
    const H = Math.max(2, Math.floor(size * dpr));

    // 1) OffscreenCanvas for Rive
    const off = new OffscreenCanvas(W, H);

    // 2) HTMLCanvas for Pixi's texture source (never swapped)
    const disp = document.createElement('canvas');
    disp.width = W;
    disp.height = H;
    const dispCtx = disp.getContext('2d', { alpha: true });
    if (!dispCtx) throw new Error('2D context not available for display canvas');

    // 3) Pixi v8: build a CanvasSource around the display canvas, then a Texture
    const dispSrc = new CanvasSource({ resource: disp });
    const texture = new Texture({ source: dispSrc });

    super({ texture });

    this._src = opts.src;
    this._autoplay = opts.autoplay ?? true;
    this._size = size;
    this._dpr = dpr;
    this._debug = opts.debug ?? true;

    this._off = off;
    this._disp = disp;
    this._dispCtx = dispCtx;
    this._dispSrc = dispSrc;

    this.log('ctor', { size, dpr, W, H, src: this._src, autoplay: this._autoplay });

    // Seed: define GPU level 0 once from the empty display canvas
    this._dispSrc.update();

    // async init
    this.init().catch((err) => this.error('init() failed', err));
  }

  get isReady() { return this._ready; }

  async setSource(src: string) {
    this.log('setSource', { from: this._src, to: src });
    this._src = src;
    await this.initRive();
  }

  pause() {
    this.log('pause');
    this._autoplay = false;
    try { (this._rive as any)?.pause?.(); } catch {}
  }

  play() {
    this.log('play');
    this._autoplay = true;
    try { (this._rive as any)?.play?.(); } catch {}
  }

  enable() {
    this.log('enable');
    if (!this._ticker) {
      this._ticker = Ticker.system;
      this._ticker.add(this._tick);
      this.log('enable.ticker.added', { systemTicker: true });
    }
  }

  disable() {
    this.log('disable');
    if (this._ticker) {
      this._ticker.remove(this._tick);
      this._ticker = undefined;
      this.log('disable.ticker.removed');
    }
  }

  destroy(options?: boolean) {
    this.log('destroy.begin', { options });
    if (this._destroyed) { this.warn('destroy.called_twice'); return; }
    this._destroyed = true;

    this.disable();
    try { this._rive?.cleanup(); this.log('destroy.rive.cleanup_ok'); }
    catch (e) { this.warn('destroy.rive.cleanup_error', e); }

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

  /** Keep both canvases sized to size×dpr. */
  private resizeCanvases(size: number, dpr: number) {
    const W = Math.max(2, Math.floor(size * dpr));
    const H = Math.max(2, Math.floor(size * dpr));

    if (this._off.width !== W || this._off.height !== H) {
      this._off.width = W;
      this._off.height = H;
      this.log('offscreen.resize', { W, H });
    }

    if (this._disp.width !== W || this._disp.height !== H) {
      this._disp.width = W;
      this._disp.height = H;
      this._dispSrc.update(); // inform Pixi that the HTMLCanvas dimensions changed
      this.log('display.resize', { W, H });
    }
  }

  private async initRive() {
    this._ready = false;

    const src = this._src;
    this.log('initRive.start', { src });

    // Fetch .riv
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

    // Ensure canvases match current DPR/size before creating Rive
    this.resizeCanvases(this._size, this._dpr);

    // Create Rive bound to our OffscreenCanvas
    try {
      this._rive = new Rive({
        buffer: bytes,
        canvas: this._off as any,   // OffscreenCanvas
        autoplay: this._autoplay,
      });
      (this._rive as any).resizeDrawingSurfaceToCanvas?.(); // once
      this.log('initRive.rive.created', { autoplay: this._autoplay });
    } catch (e) {
      this.error('initRive.rive.create_failed', e);
      throw e;
    }

    // Do one blit from offscreen → display, then upload so the first frame is visible
    this.blitAndUpload('initRive.first_blit');

    this._ready = true;
    this.log('initRive.end', { ready: this._ready });
  }

  /** Copy OffscreenCanvas → HTMLCanvas and upload to GPU. */
  private blitAndUpload(where: string) {
    try {
      const w = this._off.width, h = this._off.height;
      if (w === 0 || h === 0) {
        this.warn(`${where}.skip_zero_size`, { w, h });
        return;
      }
      // Draw offscreen onto the display canvas (same dimensions)
      this._dispCtx.drawImage(this._off as any, 0, 0);
      // Tell Pixi the CanvasSource changed
      this._dispSrc.update();
      this.debug(`${where}.ok`);
    } catch (e) {
      this.warn('blit.upload_error', e);
    }
  }

  /** Called every frame by Pixi’s ticker. */
  private update(_deltaMS: number) {
    if (!this._rive) { this.debug('update.skip.no_rive'); return; }
    if (!this._ticker) { this.debug('update.skip.no_ticker'); return; }
    this.blitAndUpload('update.upload');
  }

  // ----------------- Logging helpers -----------------
  private log(msg: string, extra?: unknown) { if (!this._debug) return; console.info(`${this.TAG} ${msg}`, extra ?? ''); }
  private debug(msg: string, extra?: unknown) { if (!this._debug) return; console.debug(`${this.TAG} ${msg}`, extra ?? ''); }
  private warn(msg: string, extra?: unknown) { if (!this._debug) return; console.warn(`${this.TAG} ${msg}`, extra ?? ''); }
  private error(msg: string, extra?: unknown) { console.error(`${this.TAG} ${msg}`, extra ?? ''); }
}

export default RiveSprite;
