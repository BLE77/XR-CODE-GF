import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const debugPort = Number(process.env.XR_METAQUEST_CHROME_DEBUG_PORT || 9223);
const targetUrl = process.env.XR_METAQUEST_SMOKE_URL || "http://127.0.0.1:4185";
const outputDir = process.env.XR_METAQUEST_SMOKE_OUTDIR || path.join(process.cwd(), ".smoke-preview");

async function requestJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function createTarget() {
  const encoded = encodeURIComponent(targetUrl);
  const target = await requestJson(`http://127.0.0.1:${debugPort}/json/new?${encoded}`, {
    method: "PUT",
  });
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chrome did not return a DevTools websocket for the smoke target.");
  }
  return target;
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  const send = (method, params = {}) => {
    const messageId = ++id;
    socket.send(JSON.stringify({ id: messageId, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
    });
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
      return;
    }
    events.push(message);
  };

  return {
    socket,
    send,
    events,
    opened: new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("Could not connect to the Chrome DevTools websocket."));
    }),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureScreenshot(send, filename) {
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const destination = path.join(outputDir, filename);
  await fs.writeFile(destination, Buffer.from(shot.data, "base64"));
  return destination;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const target = await createTarget();
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.opened;

  const { send, socket } = cdp;

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.bringToFront");
    await send("Page.reload", { ignoreCache: true });
    await wait(3500);

    const stageState = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        avatarReady: document.body.innerText.includes("Yuki avatar ready"),
        avatarMessage: Array.from(document.querySelectorAll(".immersive-stage-status-card")).find((card) => card.innerText.includes("AVATAR RUNTIME"))?.innerText ?? null,
        xrMessage: Array.from(document.querySelectorAll(".immersive-stage-status-card")).find((card) => card.innerText.includes("XR ENTRY"))?.innerText ?? null,
      })`,
      returnByValue: true,
    });

    const screenshotA = await captureScreenshot(send, "stage-a.png");
    await wait(2200);
    const screenshotB = await captureScreenshot(send, "stage-b.png");

    const [bufferA, bufferB] = await Promise.all([fs.readFile(screenshotA), fs.readFile(screenshotB)]);
    const parsed = JSON.parse(stageState.result.value);
    const result = {
      ...parsed,
      motionDetected: !bufferA.equals(bufferB),
      screenshotA,
      screenshotB,
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.avatarReady) {
      process.exitCode = 2;
    } else if (!result.motionDetected) {
      process.exitCode = 3;
    }
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
