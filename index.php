<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="description"
      content="DECIMEN — send a file between two devices through nothing but a screen and a camera, using fountain-coded QR grids."
    />
    <title>DECIMEN — Fountain QR File Transfer</title>
    <link rel="stylesheet" href="./shared/landing.css" />
  </head>
  <body>
    <header class="nav">
      <a class="brand" href="./index.php">DECIMEN</a>
      <nav class="nav-links">
        <a href="./index.php" class="on">Home</a>
        <a href="./send.php">Send</a>
        <a href="./receive.php">Receive</a>
      </nav>
    </header>

    <section class="hero">
      <span class="kicker">Screen &rarr; Camera</span>
      <h2>Send a file through <em>light</em>.</h2>
      <p>
        DECIMEN turns any file into a fountain-coded QR stream. One device plays
        it on a screen, the other reads it with a camera — no cables, no
        network path between them, no pairing.
      </p>
    </section>

    <section class="cards">
      <a class="card" href="./send.php">
        <span class="ico" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="14" rx="2" />
            <path d="M2 18h20l-3 3H5l-3-3z" />
            <path d="M12 9v6M9 11l3-3 3 3" />
          </svg>
        </span>
        <h3>Send a file</h3>
        <p>
          Pick a payload (or upload your own) and this page streams it as an
          endlessly looping, resize-aware QR code.
        </p>
        <span class="btn btn-primary">Open sender</span>
      </a>

      <a class="card" href="./receive.php">
        <span class="ico" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
            <path d="M6 15h.01" />
            <circle cx="16" cy="16" r="4" />
            <path d="m19 19 2.5 2.5" />
          </svg>
        </span>
        <h3>Receive with a phone</h3>
        <p>
          Point the camera at the sender's screen. Grid, frame size, payload —
          everything is auto-detected from the first decoded frame.
        </p>
        <span class="btn btn-primary">Open receiver</span>
      </a>
    </section>

    <h2 class="sec-title">How it works</h2>
    <section class="steps">
      <div class="step">
        <div class="n">Step 1</div>
        <h4>Fountain-code the file</h4>
        <p>
          The sender splits the file into K blocks and keeps producing encoded
          frames. Frame order is deliberately shuffled.
        </p>
      </div>
      <div class="step">
        <div class="n">Step 2</div>
        <h4>Light carries the data</h4>
        <p>
          Frames flicker as QR codes on screen. The phone captures them with the
          camera — up to four per frame on a 2×2 grid.
        </p>
      </div>
      <div class="step">
        <div class="n">Step 3</div>
        <h4>Any order, any gaps</h4>
        <p>
          Fountain coding reconstructs the file from any ~K×1.18 distinct
          blocks. Dropped or blurred frames simply get re-sent and ignored.
        </p>
      </div>
    </section>

    <div class="notice">
      <strong>Phone users:</strong> the receiver needs the camera, and browsers
      only allow that on <strong>https</strong>. From the phone, open
      <a id="receive-link" href="./receive.php">this link</a> — it fills in
      with this site's real address as you view it — and accept the
      self-signed certificate once. Set the screen to max brightness and keep
      the whole code in view.
    </div>

    <footer class="footer">Screen &rarr; camera &mdash; no network path between the devices</footer>
    <script>
      (function () {
        var link = document.getElementById("receive-link");
        if (link && window.location.protocol !== "file:") {
          link.href = new URL("./receive.php", window.location.href).href;
          link.textContent = link.href;
        }
      })();
    </script>
  </body>
</html>
