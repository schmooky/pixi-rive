
# @schmooky/pixi-rive

A tiny helper to render **Rive** animations in **PixiJS v8** using **Pixi's Ticker** and a canvas-backed texture.

```ts
import { Application } from 'pixi.js';
import { RiveSprite } from '@schmooky/pixi-rive';

const app = new Application();
await app.init({ background: '#0b102a', resizeTo: window });

const rive = new RiveSprite({
  src: 'https://public.rive.app/community/runtime-files/3723-7246-jumping-fox.riv',
  autoplay: true,
  size: 512,
});

rive.x = (app.screen.width - 512) / 2;
rive.y = (app.screen.height - 512) / 2;
app.stage.addChild(rive);
```

## Install

```
npm i @schmooky/pixi-rive
```

**Peer deps:** `pixi.js@^8`
