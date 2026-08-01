<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no"
    />
    <title>Optical Transfer — receive</title>
    <link rel="stylesheet" href="./shared/style.css" />
  </head>
  <body>
    <h1>DECIMEN <small>— Fountain QR File Transfer</small></h1>
    <div class="hint" id="stats">point the camera at the sender's code</div>
    <details class="settings" id="settings">
      <summary>Settings</summary>
      <div class="row">
        <label>
          capture width
          <select id="cfg-width">
            <option value="auto" selected>auto</option>
            <option>960</option>
            <option>1280</option>
            <option>1920</option>
          </select>
        </label>
        <label>
          capture fps
          <select id="cfg-capfps">
            <option value="auto" selected>auto</option>
            <option>30</option>
            <option>60</option>
          </select>
        </label>
        <label>
          decode workers
          <select id="cfg-workers">
            <option value="auto" selected>auto</option>
            <option>1</option>
            <option>2</option>
            <option>3</option>
          </select>
        </label>
      </div>
      <div class="hint" style="text-align: left; padding-top: 8px">
        Everything is <strong>auto</strong>: the receiver detects the sender's
        mode on the first decoded frame — grid (1×1 or 2×2), frame size, block
        count, payload — and adapts instantly. No pairing, no mode to pick. If
        codes aren't found, back up so the whole screen is in view; the decoder
        also auto-zooms small QRs. 2×2 sender grids work best with 2-3 workers.
      </div>
    </details>
    <button id="start">Start camera</button>
    <div class="metrics" id="metrics" style="display: none">
      <div class="metric"><div class="k">capture fps</div><div class="v" id="m-cap">—</div></div>
      <div class="metric"><div class="k">decode fps</div><div class="v amber" id="m-dec">—</div></div>
      <div class="metric"><div class="k">goodput</div><div class="v amber" id="m-rate">—</div></div>
      <div class="metric"><div class="k">elapsed</div><div class="v" id="m-time">—</div></div>
      <div class="metric"><div class="k">frames new/dup</div><div class="v" id="m-frames">—</div></div>
      <div class="metric"><div class="k">blocks K</div><div class="v" id="m-k">—</div></div>
      <div class="metric"><div class="k">block len</div><div class="v" id="m-block">—</div></div>
      <div class="metric"><div class="k">received</div><div class="v" id="m-payload">—</div></div>
    </div>
    <div class="preview" id="preview" style="display: none">
      <video id="video" muted playsinline></video>
    </div>
    <div class="progress" id="progress" style="display: none"><div id="bar"></div></div>
    <div class="hint" id="barpct" style="display: none">0%</div>
    <div id="result"></div>
    <script type="module" src="./receive/main.js"></script>
  </body>
</html>
