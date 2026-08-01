<?php
require __DIR__ . '/shared/payloads.php';
$payloads = pd_payload_list();
?>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Optical Transfer — send</title>
    <link rel="stylesheet" href="./shared/style.css" />
  </head>
  <body>
    <h1>DECIMEN <small>— Fountain QR File Transfer</small></h1>
    <div class="hint" id="specs">loading payload…</div>
    <div class="hint" id="live" style="display: none"></div>
    <details class="settings">
      <summary>Settings</summary>
      <div class="row">
        <label>
          payload
          <select id="cfg-payload">
            <?php foreach ($payloads as $p): ?>
            <option value="<?= htmlspecialchars((string)$p['id'], ENT_QUOTES) ?>"
                    data-name="<?= htmlspecialchars((string)$p['name'], ENT_QUOTES) ?>"
                    data-gz="<?= $p['gz'] ? '1' : '0' ?>">
              <?= htmlspecialchars((string)$p['name'], ENT_QUOTES) ?>
              (<?= (int)round((int)$p['size'] / 1024) ?> KB<?= $p['gz'] ? ', gz' : '' ?><?= $p['demo'] ? ', demo' : '' ?>)
            </option>
            <?php endforeach; ?>
          </select>
        </label>
        <label>
          tx fps
          <select id="cfg-fps">
            <option value="auto" selected>auto</option>
            <option>10</option>
            <option>15</option>
            <option>20</option>
            <option>24</option>
            <option>30</option>
            <option>60</option>
          </select>
        </label>
        <label>
          bytes / frame
          <select id="cfg-bytes">
            <option value="auto" selected>auto</option>
            <option>500</option>
            <option>1000</option>
            <option>1465</option>
            <option>1850</option>
            <option>2331</option>
            <option>2953</option>
          </select>
        </label>
        <label>
          error correction
          <select id="cfg-ecc">
            <option value="auto" selected>auto</option>
            <option>L</option>
            <option>M</option>
            <option>Q</option>
            <option>H</option>
          </select>
        </label>
        <label>
          grid
          <select id="cfg-grid">
            <option value="auto" selected>auto</option>
            <option value="1">1×1</option>
            <option value="2">2×2</option>
          </select>
        </label>
        <label>
          display size
          <select id="cfg-size">
            <option value="auto" selected>auto (fit screen)</option>
            <option value="300">300 px</option>
            <option value="500">500 px</option>
            <option value="700">700 px</option>
            <option value="900">900 px</option>
            <option value="1200">1200 px</option>
          </select>
        </label>
        <label>
          QR size
          <input id="cfg-zoom" type="range" min="20" max="100" value="100" />
          <span id="cfg-zoom-val" style="font-size: 12px">100%</span>
        </label>
        <label>
          upload payload
          <input id="cfg-upload" type="file" />
        </label>
      </div>
      <div class="hint" style="text-align: left; padding-top: 8px">
        Everything is <strong>auto</strong> by default — it picks the speed,
        frame size, QR version, grid (<strong>1×1</strong>) and display size
        for the payload, and re-scales automatically if you resize the window
        or go fullscreen (resizing never restarts the stream). Drag the
        <strong>QR size</strong> slider to zoom the code in/out live — instant,
        no restart. Pick the 2×2 grid for ~4× the goodput if you want; keep
        the whole screen in view on the receiver.
      </div>
    </details>
    <div class="stage"><canvas id="qr" width="16" height="16"></canvas></div>
    <div>
      <button id="fullscreen">Fullscreen</button>
      <span class="hint" style="display:inline">bigger on screen = easier for the camera</span>
    </div>
    <div class="hint">
      Max screen brightness helps. The stream loops forever — stop when the
      receiver says done.
    </div>
    <script src="./shared/vendor/qrcodegen.js"></script>
    <script type="module" src="./send/main.js"></script>
  </body>
</html>
