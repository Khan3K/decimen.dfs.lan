<?php
declare(strict_types=1);

require __DIR__ . '/shared/payloads.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

const PD_MAX_UPLOAD = 64 * 1024 * 1024; // 64 MB (upload_max_filesize must cover this)

function pd_out(array $data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function pd_err(string $msg, int $code = 400): never
{
    pd_out(['error' => $msg, 'code' => $code], $code);
}

function pd_method(string $want): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== $want) {
        pd_err('method not allowed', 405);
    }
}

/** Stream a file with Range support. Always exits. */
function pd_stream_file(string $path): never
{
    $size = (int)filesize($path);
    $start = 0;
    $end = $size - 1;

    if (isset($_SERVER['HTTP_RANGE']) && preg_match('/^bytes=(\d*)-(\d*)$/', (string)$_SERVER['HTTP_RANGE'], $m)) {
        $s = $m[1] === '' ? null : (int)$m[1];
        $e = $m[2] === '' ? null : (int)$m[2];
        if ($s === null && $e === null) {
            pd_err('invalid range', 416);
        }
        if ($s !== null) {
            $start = $s;
            $end = $e !== null ? min($e, $size - 1) : $size - 1;
        } else {
            $start = max(0, $size - (int)$e);
            $end = $size - 1;
        }
        if ($start > $end || $start >= $size) {
            pd_err('range not satisfiable', 416);
        }
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    }

    header('Content-Length: ' . ($end - $start + 1));
    header('Accept-Ranges: bytes');

    $fh = @fopen($path, 'rb');
    if (!$fh) {
        pd_err('cannot open file', 500);
    }
    if (fseek($fh, $start) !== 0) {
        fclose($fh);
        pd_err('seek failed', 500);
    }
    $remaining = $end - $start + 1;
    while ($remaining > 0 && !feof($fh)) {
        $chunk = fread($fh, min(1048576, $remaining));
        if ($chunk === false || $chunk === '') {
            break;
        }
        $remaining -= strlen($chunk);
        echo $chunk;
        flush();
    }
    fclose($fh);
    exit;
}

$action = (string)($_GET['action'] ?? 'list');

switch ($action) {
    case 'list':
        pd_out(['files' => pd_payload_list()]);

    case 'upload':
        pd_method('POST');
        if (!isset($_FILES['file'])) {
            pd_err('missing file field');
        }
        $f = $_FILES['file'];
        if (!is_array($f) || !isset($f['tmp_name'], $f['error'], $f['size'], $f['name'])) {
            pd_err('missing file field');
        }
        if ($f['error'] !== UPLOAD_ERR_OK) {
            pd_err('upload failed (error ' . $f['error'] . ')');
        }
        if ((int)$f['size'] <= 0) {
            pd_err('empty file');
        }
        if ((int)$f['size'] > PD_MAX_UPLOAD) {
            pd_err('file too large (max ' . (int)(PD_MAX_UPLOAD / 1048576) . ' MB)');
        }
        $name = pd_sanitize_name((string)$f['name']);
        $id = pd_safe_id();
        $dest = pd_storage_dir() . '/' . $id;
        if (!is_dir(pd_storage_dir())) {
            @mkdir(pd_storage_dir(), 0777, true);
        }
        if (!move_uploaded_file((string)$f['tmp_name'], $dest)) {
            pd_err('could not store file', 500);
        }

        // gzip copy for transport compression
        $gz = false;
        $data = file_get_contents($dest);
        if ($data !== false) {
            $gzData = gzencode($data, 6);
            if ($gzData !== false) {
                file_put_contents($dest . '.gz', $gzData);
                $gz = true;
            }
        }

        $m = pd_manifest_read();
        $m[$id] = [
            'name' => $name,
            'size' => (int)$f['size'],
            'mtime' => time(),
            'mime' => pd_mime($dest),
            'gz' => $gz,
        ];
        pd_manifest_write($m);
        pd_out(['id' => $id, 'name' => $name, 'size' => (int)$f['size'], 'gz' => $gz]);

    case 'stream':
        $id = (string)($_GET['id'] ?? '');
        if ($id === '') {
            pd_err('missing id');
        }
        $gz = !empty($_GET['gz']);
        $demo = pd_demo_path($id);
        if ($demo !== null) {
            header('Content-Type: ' . pd_mime($demo));
            pd_stream_file($demo);
        }
        $meta = pd_manifest_read();
        if (!isset($meta[$id])) {
            pd_err('unknown id', 404);
        }
        $raw = pd_storage_dir() . '/' . $id;
        if (!is_file($raw)) {
            pd_err('missing file', 404);
        }
        if ($gz && !empty($meta[$id]['gz']) && is_file($raw . '.gz')) {
            // Serve the raw gzip bytes; the client decompresses with the
            // DecompressionStream API. No Content-Encoding header here so the
            // fetch is not double-decoded by the browser.
            header('Content-Type: application/gzip');
            pd_stream_file($raw . '.gz');
        }
        header('Content-Type: ' . ($meta[$id]['mime'] ?? 'application/octet-stream'));
        pd_stream_file($raw);

    case 'save':
        pd_method('POST');
        $raw = file_get_contents('php://input');
        if ($raw === false) {
            pd_err('no body');
        }
        $j = json_decode($raw, true);
        if (!is_array($j)) {
            pd_err('invalid JSON');
        }
        $name = pd_sanitize_name((string)($j['name'] ?? 'received.bin'));
        $b64 = (string)($j['data'] ?? '');
        if ($b64 === '') {
            pd_err('missing data');
        }
        $bin = base64_decode($b64, true);
        if ($bin === false) {
            pd_err('invalid base64');
        }
        $size = strlen($bin);
        if ($size <= 0) {
            pd_err('empty payload');
        }
        if ($size > PD_MAX_UPLOAD) {
            pd_err('payload too large');
        }
        $id = pd_safe_id();
        $dest = pd_received_dir() . '/' . $id;
        if (!is_dir(pd_received_dir())) {
            @mkdir(pd_received_dir(), 0777, true);
        }
        if (file_put_contents($dest, $bin) === false) {
            pd_err('could not write file', 500);
        }
        $fnvOk = null;
        if (isset($j['fnv'])) {
            $want = (int)$j['fnv'];
            $got = pd_fnv1a_bytes($bin);
            $fnvOk = $got === $want;
        }
        pd_out([
            'id' => $id,
            'name' => $name,
            'size' => $size,
            'mime' => (string)($j['mime'] ?? 'application/octet-stream'),
            'stored' => true,
            'fnvOk' => $fnvOk,
        ]);

    case 'delete':
        pd_method('POST');
        $id = (string)($_GET['id'] ?? '');
        if ($id === '' || pd_demo_path($id) !== null) {
            pd_err('cannot delete', 400);
        }
        $m = pd_manifest_read();
        if (!isset($m[$id])) {
            pd_err('unknown id', 404);
        }
        @unlink(pd_storage_dir() . '/' . $id);
        @unlink(pd_storage_dir() . '/' . $id . '.gz');
        unset($m[$id]);
        pd_manifest_write($m);
        pd_out(['deleted' => true]);

    case 'peek':
        $id = (string)($_GET['id'] ?? '');
        if ($id === '') {
            pd_err('missing id');
        }
        $demo = pd_demo_path($id);
        if ($demo !== null) {
            pd_out([
                'id' => $id,
                'name' => $id,
                'size' => (int)filesize($demo),
                'mime' => pd_mime($demo),
                'gz' => false,
                'totalLen' => (int)filesize($demo),
            ]);
        }
        $meta = pd_manifest_read();
        if (!isset($meta[$id])) {
            pd_err('unknown id', 404);
        }
        $raw = pd_storage_dir() . '/' . $id;
        if (!is_file($raw)) {
            pd_err('missing file', 404);
        }
        $size = (int)filesize($raw);
        pd_out([
            'id' => $id,
            'name' => (string)($meta[$id]['name'] ?? $id),
            'size' => $size,
            'mime' => (string)($meta[$id]['mime'] ?? 'application/octet-stream'),
            'gz' => !empty($meta[$id]['gz']) && is_file($raw . '.gz'),
            'totalLen' => $size,
        ]);

    default:
        pd_err('unknown action', 404);
}
