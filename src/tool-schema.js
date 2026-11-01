/**
 * 把上游工具 schema（DSH 的紧凑写法）转成 Cortico 认的 JSON Schema。
 *
 * 上游写法是「参数名 → { type, required: true, description }」，必填是参数对象里的一个布尔；
 * 标准 JSON Schema 要求 properties + required 数组。两层嵌套（对象参数）也要一起转，
 * 否则模型拿到的是一个没有必填项的 schema，参数会被静默丢掉。
 */

function convertObject(properties) {
  const out = {};
  const required = [];
  for (const [key, spec] of Object.entries(properties)) {
    if (!spec || typeof spec !== 'object') { out[key] = spec; continue; }
    const { required: isRequired, ...rest } = spec;
    if (isRequired === true) required.push(key);
    out[key] = normalize(rest);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: out,
    ...(required.length ? { required } : {}),
  };
}

function normalize(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const next = { ...spec };
  if (next.type === 'object' && next.properties && typeof next.properties === 'object') {
    const nested = convertObject(next.properties);
    delete next.properties;
    const required = Array.isArray(next.required) ? next.required : [];
    return { ...next, ...nested, ...(required.length ? { required: [...new Set([...(nested.required ?? []), ...required])] } : {}) };
  }
  if (next.type === 'array' && next.items) return { ...next, items: normalize(next.items) };
  return next;
}

/** 上游 `parameters` → `{ type:'object', properties, required }`。 */
export function toJsonSchema(parameters) {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {} };
  if (parameters.type === 'object' && parameters.properties) return normalize(parameters);
  return convertObject(parameters);
}
