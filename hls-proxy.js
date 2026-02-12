const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade'
]);

const PRIVATE_HOST_PATTERNS = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^0\.0\.0\.0$/,
    /^169\.254\./
];

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getFirstQueryValue(value) {
    if (Array.isArray(value)) return String(value[0] || '');
    return String(value || '');
}

function getProxyBase(req) {
    const explicit = String(process.env.HLS_PROXY_ORIGIN || '').trim().replace(/\/+$/g, '');
    if (explicit) return explicit;

    const forwardedProto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return `${forwardedProto}://${forwardedHost}`;
}

function getAllowList() {
    const raw = String(process.env.HLS_PROXY_ALLOWED_HOSTS || '').trim();
    if (!raw) return [];
    return raw
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase().trim();
    return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function isAllowedHost(hostname, allowList) {
    const host = String(hostname || '').toLowerCase().trim();
    if (!host) return false;
    if (isPrivateHost(host)) return false;
    if (!allowList.length) return true;

    return allowList.some((allowed) => {
        if (allowed === host) return true;
        if (allowed.startsWith('*.')) {
            const suffix = allowed.slice(1); // ".example.com"
            return host.endsWith(suffix);
        }
        return host.endsWith(`.${allowed}`);
    });
}

function buildProxyUrl(proxyBase, targetUrl, referer, userAgent) {
    const query = new URLSearchParams({ url: targetUrl });
    if (referer) query.set('referer', referer);
    if (userAgent) query.set('ua', userAgent);
    return `${proxyBase}/api/hls-proxy?${query.toString()}`;
}

function rewritePlaylist(content, playlistUrl, proxyBase, referer, userAgent) {
    const lines = String(content || '').split('\n');
    const out = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => {
                try {
                    const absolute = new URL(rawUri, playlistUrl).toString();
                    return `URI="${buildProxyUrl(proxyBase, absolute, referer, userAgent)}"`;
                } catch (error) {
                    return `URI="${rawUri}"`;
                }
            });
        }

        try {
            const absolute = new URL(trimmed, playlistUrl).toString();
            return buildProxyUrl(proxyBase, absolute, referer, userAgent);
        } catch (error) {
            return line;
        }
    });

    return out.join('\n');
}

function isPlaylistResponse(contentType, url) {
    const type = String(contentType || '').toLowerCase();
    const href = String(url || '').toLowerCase();
    return (
        type.includes('application/vnd.apple.mpegurl')
        || type.includes('application/x-mpegurl')
        || href.includes('.m3u8')
    );
}

module.exports = async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    const rawUrl = getFirstQueryValue(req.query.url).trim();
    const referer = getFirstQueryValue(req.query.referer).trim();
    const userAgent = getFirstQueryValue(req.query.ua).trim() || DEFAULT_USER_AGENT;

    if (!rawUrl) {
        res.status(400).json({ error: 'Missing "url" query parameter.' });
        return;
    }

    let target;
    try {
        target = new URL(rawUrl);
    } catch (error) {
        res.status(400).json({ error: 'Invalid "url" query parameter.' });
        return;
    }

    if (!/^https?:$/i.test(target.protocol)) {
        res.status(400).json({ error: 'Only HTTP/HTTPS URLs are allowed.' });
        return;
    }

    const allowList = getAllowList();
    if (!isAllowedHost(target.hostname, allowList)) {
        res.status(403).json({ error: `Target host is not allowed: ${target.hostname}` });
        return;
    }

    const headers = {
        'user-agent': userAgent,
        'accept': '*/*'
    };

    if (referer) {
        headers.referer = referer;
        try {
            headers.origin = new URL(referer).origin;
        } catch (error) {
            // Ignore invalid referer for origin.
        }
    }

    try {
        const upstream = await fetch(target.toString(), {
            method: 'GET',
            headers,
            redirect: 'follow'
        });

        const upstreamContentType = upstream.headers.get('content-type') || '';
        const proxyBase = getProxyBase(req);

        if (!upstream.ok) {
            const errorText = await upstream.text();
            res.status(upstream.status).json({
                error: `Upstream request failed (${upstream.status})`,
                target: target.hostname,
                body: String(errorText || '').slice(0, 400)
            });
            return;
        }

        if (isPlaylistResponse(upstreamContentType, upstream.url)) {
            const text = await upstream.text();
            const rewritten = rewritePlaylist(text, upstream.url, proxyBase, referer, userAgent);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).send(rewritten);
            return;
        }

        const buffer = Buffer.from(await upstream.arrayBuffer());

        upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (HOP_BY_HOP_HEADERS.has(lower)) return;
            if (lower === 'content-security-policy') return;
            res.setHeader(key, value);
        });

        if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', 'application/octet-stream');
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(buffer);
    } catch (error) {
        res.status(502).json({
            error: 'Proxy fetch failed',
            detail: String(error?.message || error || 'unknown error')
        });
    }
};
