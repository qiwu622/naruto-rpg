import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const HELP = `NovelAI diagnostics (Node.js 20+)

  node scripts/verify-novelai.mjs
    GET official tag suggestions through the real project proxy.
    Network-only: HTTP 200 does NOT validate a token or generation access.

  node scripts/verify-novelai.mjs --generate --stdin-key
    Read a token from piped stdin; generate one 512x512 image in memory.
    May consume NovelAI credits. No retries; no token or image is saved.

Options:
  --stdin-key         Read the token only from a pipe, never argv or an env key.
  --generate          Explicitly enable one image generation request.
  --model ID          Default: nai-diffusion-4-5-full.
  --steps 1|2|3       Default: 1.
  --timeout-ms N      1000..300000; default: 20000 (GET), 120000 (generation).
  --help             Show help without contacting any server.

AI_PROXY_FORWARD_URL configures the server's outbound HTTP CONNECT proxy.
See docs/novelai-troubleshooting.md. Never put a token in the command line.
`;

function usageError(message) {
  return Object.assign(new Error(message), { code: 'DIAGNOSTIC_USAGE' });
}

function parseOptions(args) {
  const options = { generate: false, stdinKey: false, model: 'nai-diffusion-4-5-full', steps: 1 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--generate') options.generate = true;
    else if (arg === '--stdin-key') options.stdinKey = true;
    else if (arg === '--help') options.help = true;
    else if (['--model', '--steps', '--timeout-ms'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw usageError('An option value is missing; use --help.');
      if (arg === '--model') options.model = value;
      else if (arg === '--steps') options.steps = Number(value);
      else options.timeoutMs = Number(value);
    } else throw usageError('Unsupported option; use --help. Tokens are accepted only through stdin.');
  }
  options.timeoutMs ??= options.generate ? 120000 : 20000;
  if (!/^[a-z0-9._-]{1,80}$/.test(options.model)) throw usageError('Invalid model ID.');
  if (![1, 2, 3].includes(options.steps)) throw usageError('--steps must be 1, 2 or 3.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300000) {
    throw usageError('--timeout-ms must be an integer between 1000 and 300000.');
  }
  if (options.generate && !options.stdinKey && !options.help) {
    throw usageError('--generate requires --stdin-key. No request was sent.');
  }
  return options;
}

async function readToken() {
  if (process.stdin.isTTY) throw usageError('--stdin-key requires a pipe to prevent terminal echo.');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) throw usageError('Token input exceeds the size limit.');
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString('utf8').trim().replace(/^Bearer\s+/i, '').replace(/\\_/g, '_').trim();
  if (!token || /\s/.test(token)) throw usageError('Token input is empty or contains whitespace.');
  return token;
}

function safeMessage(error, token) {
  let message = String(error?.message || 'Request failed');
  if (token) message = message.split(token).join('[REDACTED]');
  return message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]').slice(0, 500);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  let token = options.stdinKey ? await readToken() : '';

  // Set these before importing config/router. Never start server/index.js or initDb().
  process.env.NODE_ENV = 'test';
  process.env.MULTIPLAYER_ENABLED = 'false';
  process.env.AUTH_BYPASS = 'false';
  process.env.AI_PROXY_RETRY_MAX_ATTEMPTS = '0';
  process.env.IMAGE_PROXY_TIMEOUT_MS = String(options.timeoutMs);
  const [{ default: express }, { default: proxyRouter }, { config }, { ImageTransport }, { NovelAIImageAdapter }] = await Promise.all([
    import('express'),
    import('../server/api/ai-proxy.js'),
    import('../server/config.js'),
    import('../js/core/image-studio/transport.js'),
    import('../js/core/image-studio/adapters.js')
  ]);
  if (config.proxy.upstreamRetry.maxAttempts !== 0) throw new Error('Cannot run diagnostics while proxy retries are enabled.');

  const report = {
    mode: options.generate ? 'generate' : 'network-only',
    forwardProxyConfigured: Boolean(config.proxy.aiForwardUrl),
    tokenProvided: Boolean(token), tokenVerified: false,
    generationAttempted: options.generate, retries: 0,
    timeoutMs: options.timeoutMs, model: options.model
  };
  const session = randomUUID();
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/ai-proxy', (req, res, next) => {
    if (req.headers['x-diagnostic-session'] !== session) return res.sendStatus(403);
    // Router auth takes this identity and never invokes the user database.
    req.user = { id: 'novelai-isolated-diagnostic' };
    next();
  }, express.json({ limit: '64kb' }), proxyRouter);
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: safeMessage(error, token) });
  });

  const server = app.listen(0, '127.0.0.1');
  let requestCount = 0;
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = new ImageTransport({
      async fetchImpl(url, init) {
        if (++requestCount !== 1) throw new Error('Diagnostics allow only one provider request.');
        const target = new URL(url, origin);
        if (target.origin !== origin || target.pathname !== '/api/ai-proxy') {
          throw new Error('Diagnostics must use the isolated project proxy.');
        }
        const response = await fetch(target, {
          ...init, headers: { ...init.headers, 'x-diagnostic-session': session }
        });
        report.httpStatus = response.status;
        report.contentType = response.headers.get('content-type') || '';
        return response;
      }
    });
    const provider = {
      type: 'novelai', apiUrl: 'https://image.novelai.net',
      apiKey: token, apiKeyHeader: 'Authorization', model: options.model
    };
    const signal = AbortSignal.timeout(options.timeoutMs);
    if (options.generate) {
      const result = await new NovelAIImageAdapter(transport).generate({
        provider, prompt: 'a red circle on a plain white background, simple flat colors',
        negativePrompt: 'text, watermark',
        parameters: { width: 512, height: 512, steps: options.steps, seed: 1 }, signal
      });
      const image = result.images?.[0];
      if (result.images?.length !== 1 || !image?.blob?.size || image.width !== 512 || image.height !== 512) {
        throw new Error('Generation did not return exactly one valid 512x512 image.');
      }
      report.tokenVerified = true;
      report.image = { mimeType: image.mimeType, width: image.width, height: image.height, bytes: image.blob.size };
      report.steps = options.steps;
      report.message = 'One image was generated and decoded in memory; nothing was saved.';
    } else {
      const query = new URLSearchParams({ model: options.model, prompt: 'landscape', lang: 'en' });
      const result = await transport.json(provider, `/ai/generate-image/suggest-tags?${query}`, { signal });
      if (!Array.isArray(result?.tags)) throw new Error('Official tag endpoint returned an unexpected response shape.');
      report.tagCount = result.tags.length;
      report.message = 'Tag endpoint connected. It can return 200 for invalid tokens; authentication, balance and image generation remain unverified.';
    }
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = { code: error?.code || (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'DIAGNOSTIC_FAILED'), message: safeMessage(error, token) };
    process.exitCode = 1;
  } finally {
    report.requestCount = requestCount;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    token = '';
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error?.code || 'DIAGNOSTIC_SETUP_FAILED', message: safeMessage(error, '') }));
  process.exitCode = error?.code === 'DIAGNOSTIC_USAGE' ? 2 : 1;
});
