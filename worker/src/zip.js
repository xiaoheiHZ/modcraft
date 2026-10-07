/**
 * 迷你 ZIP 读取工具 —— 用于浏览构建产物（artifact zip 里取出 jar，再列/取 jar 内的文件）
 * 仅依赖标准 Web API（DecompressionStream 解 deflate-raw），无需第三方库。
 */
const zipU16 = (b, o) => b[o] | (b[o + 1] << 8);
const zipU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** 列出 ZIP 中的所有条目（文件名 / 压缩方式 / 大小 / 本地头偏移） */
export function zipList(bytes) {
  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (zipU32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = zipU16(bytes, eocd + 10);
  let off = zipU32(bytes, eocd + 16);
  const entries = [];
  for (let i = 0; i < count && off + 46 <= bytes.length; i++) {
    if (zipU32(bytes, off) !== 0x02014b50) break;
    const method = zipU16(bytes, off + 10);
    const compSize = zipU32(bytes, off + 20);
    const uncompSize = zipU32(bytes, off + 24);
    const nameLen = zipU16(bytes, off + 28);
    const extraLen = zipU16(bytes, off + 30);
    const commentLen = zipU16(bytes, off + 32);
    const localOff = zipU32(bytes, off + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取出某个条目的原始字节（stored 直接切片，deflate 用 DecompressionStream 解压） */
export async function zipExtract(bytes, entry) {
  const o = entry.localOff;
  if (zipU32(bytes, o) !== 0x04034b50) throw new Error('ZIP 条目损坏');
  const nameLen = zipU16(bytes, o + 26);
  const extraLen = zipU16(bytes, o + 28);
  const start = o + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('不支持的压缩方式: ' + entry.method);
}

/** 按扩展名给 Content-Type */
export function mimeOf(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (['txt', 'toml', 'mcmeta', 'lang', 'properties', 'cfg', 'md', 'java', 'json5'].includes(ext)) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

const ghAuthHeaders = (env) => ({
  authorization: `Bearer ${env.GITHUB_TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'modcraft-worker',
});

/** 拉取构建产物 ZIP（带边缘缓存） */
export async function getArtifactZip(env, task) {
  const cache = caches.default;
  const key = new Request('https://artifact-cache.internal/' + task.artifact_id);
  const hit = await cache.match(key);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/artifacts/${task.artifact_id}/zip`;
      let r = await fetch(apiUrl, { headers: ghAuthHeaders(env), redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        r = await fetch(r.headers.get('location'));
      }
      if (!r.ok) throw new Error('GitHub 产物获取失败 ' + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      try {
        await cache.put(key, new Response(buf, { headers: { 'cache-control': 'max-age=86400' } }));
      } catch { /* 缓存失败不影响功能 */ }
      return buf;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 400));
    }
  }
  throw lastErr || new Error('产物获取失败');
}

/** 从产物 zip 中取出 jar 的字节 */
export async function getJarBytes(env, task) {
  const zip = await getArtifactZip(env, task);
  const entries = zipList(zip);
  const jar = entries.find(e => e.name.endsWith('.jar') && !e.name.endsWith('-sources.jar'))
    || entries.find(e => e.name.endsWith('.jar'));
  if (!jar) throw new Error('产物里没有 jar 文件');
  return await zipExtract(zip, jar);
}
