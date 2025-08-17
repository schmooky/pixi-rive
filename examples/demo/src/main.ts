import { Application, Container, Graphics } from "pixi.js";
import { RiveSprite } from "@schmooky/pixi-rive";
const app = new Application();
await app.init({ background: "#0b102a", resizeTo: window, hello: true });
document.getElementById("app")!.appendChild(app.canvas);

const riv = new RiveSprite({ src: "/vehicles.riv", autoplay: true, size: 512 });

const panel = new Container();
app.stage.addChild(panel);

// const bg = new Graphics().roundRect(0, 0, 560, 560, 24)
//   .fill(0x141938)
//   .stroke({ width: 2, color: 0x2a3366 });
// panel.addChild(bg);

riv.x = 24;
riv.y = 24;
panel.addChild(riv);

