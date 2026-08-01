<?php
declare(strict_types=1);

// Shared payload helpers used by api.php (JSON API) and send.php (which
// server-renders the payload <select> so the page works even before the
// first API call completes).

function pd_root(): string
{
    return dirname(__DIR__);
}

function pd_public_dir(): string
{
    return pd_root() . '/public';
}

function pd_storage_dir(): string
{
    return pd_root() . '/storage';
}

function pd_received_dir(): string
{
    return pd_root() . '/received';
}

function pd_manifest(): string
{
    return pd_storage_dir() . '/manifest.json';
}

function pd_manifest_read(): array
{
    if (!is_file(pd_manifest())) {
        return [];
    }
    $j = json_decode((string)file_get_contents(pd_manifest()), true);
    return is_array($j) ? $j : [];
}

function pd_manifest_write(array $m): void
{
    if (!is_dir(pd_storage_dir())) {
        @mkdir(pd_storage_dir(), 0777, true);
    }
    file_put_contents(pd_manifest(), json_encode($m, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function pd_mime(string $path): string
{
    if (function_exists('finfo_open')) {
        $fi = @finfo_open(FILEINFO_MIME_TYPE);
        if ($fi) {
            $m = @finfo_file($fi, $path);
            finfo_close($fi);
            if ($m) {
                return (string)$m;
            }
        }
    }
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $map = [
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'txt' => 'text/plain',
        'html' => 'text/html',
        'htm' => 'text/html',
        'css' => 'text/css',
        'js' => 'application/javascript',
        'json' => 'application/json',
        'pdf' => 'application/pdf',
        'zip' => 'application/zip',
        'gz' => 'application/gzip',
        'mp4' => 'video/mp4',
        'mp3' => 'audio/mpeg',
    ];
    return $map[$ext] ?? 'application/octet-stream';
}

function pd_safe_id(): string
{
    return bin2hex(random_bytes(8));
}

function pd_sanitize_name(string $name): string
{
    $name = str_replace('\\', '/', $name);
    $name = basename($name);
    $name = (string)preg_replace('/[\x00-\x1f\x7f<>:"|?*]/', '_', $name);
    $name = trim($name);
    if ($name === '' || $name === '.' || $name === '..') {
        $name = 'payload';
    }
    if (strlen($name) > 200) {
        $name = substr($name, 0, 200);
    }
    return $name;
}

// Demo payloads ship in public/ and can never be deleted.
const PD_DEMOS = ['success.png', 'success-2mb.png'];

function pd_demo_path(string $id): ?string
{
    foreach (PD_DEMOS as $d) {
        if ($id === $d) {
            $p = pd_public_dir() . '/' . $d;
            return is_file($p) ? $p : null;
        }
    }
    return null;
}

/** The full list of sendable payloads (demos first, then uploads). */
function pd_payload_list(): array
{
    $files = [];
    foreach (PD_DEMOS as $d) {
        $p = pd_public_dir() . '/' . $d;
        if (!is_file($p)) {
            continue;
        }
        $files[] = [
            'id' => $d,
            'name' => $d,
            'size' => (int)filesize($p),
            'mtime' => (int)filemtime($p),
            'mime' => pd_mime($p),
            'gz' => false,
            'demo' => true,
        ];
    }
    foreach (pd_manifest_read() as $id => $meta) {
        $p = pd_storage_dir() . '/' . $id;
        if (!is_file($p)) {
            continue;
        }
        $files[] = [
            'id' => (string)$id,
            'name' => (string)($meta['name'] ?? $id),
            'size' => (int)filesize($p),
            'mtime' => (int)($meta['mtime'] ?? filemtime($p)),
            'mime' => (string)($meta['mime'] ?? 'application/octet-stream'),
            'gz' => !empty($meta['gz']) && is_file(pd_storage_dir() . '/' . $id . '.gz'),
            'demo' => false,
        ];
    }
    usort($files, static fn(array $a, array $b): int => ($b['demo'] <=> $a['demo']) ?: ($a['name'] <=> $b['name']));
    return $files;
}

/** FNV-1a over a byte string, matching shared/protocol.js (uint32, >>> 0). */
function pd_fnv1a_bytes(string $data): int
{
    $h = 0x811c9dc5;
    $len = strlen($data);
    for ($i = 0; $i < $len; $i++) {
        $h ^= ord($data[$i]);
        $h = ($h * 0x01000193) & 0xFFFFFFFF;
    }
    return (int)$h;
}
