// Shared CloudFront Function template used by both the CDK stack (bootstrap)
// and the org Lambda (runtime regeneration when custom domains change).
//
// The function decides routing per viewer request:
//   1. If the Host is in `domainMap`:
//        - entry.s → rewrite URI as `/{schema}${uri}` and forward.
//        - entry.r → emit a 301 to the canonical host, preserving path + query.
//   2. Otherwise, if the Host is a subdomain of the org's customDomain, strip
//      that suffix and prepend it as the schema (e.g. webifood.<org> → /webifood).

export type DomainMapEntry = { s: string } | { r: string };
export type DomainMap = Record<string, DomainMapEntry>;

export function renderCloudFrontFunction(
  customDomain: string,
  domainMap: DomainMap
): string {
  const mapJson = JSON.stringify(domainMap);
  const cdJson = JSON.stringify(customDomain);
  return `function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  // Preserve the viewer Host for origin Lambdas: CloudFront otherwise
  // rewrites the Host header to the API Gateway origin domain, and our
  // OriginRequestPolicy can't forward Host itself. CF-Function header
  // additions bypass the allowlist so this reaches the Lambda as-is.
  request.headers['x-forwarded-host'] = { value: host };
  var customDomain = ${cdJson};
  var domainMap = ${mapJson};
  var entry = domainMap[host];
  if (entry) {
    if (entry.r) {
      var qs = '';
      if (request.querystring) {
        var parts = [];
        for (var k in request.querystring) {
          var v = request.querystring[k];
          if (v && v.multiValue) {
            for (var i = 0; i < v.multiValue.length; i++) {
              parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v.multiValue[i].value));
            }
          } else if (v) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v.value));
          }
        }
        if (parts.length) qs = '?' + parts.join('&');
      }
      return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: { location: { value: 'https://' + entry.r + request.uri + qs } }
      };
    }
    if (entry.s) {
      request.uri = '/' + entry.s + request.uri;
      return request;
    }
  }
  if (host !== customDomain && host.endsWith('.' + customDomain)) {
    var appName = host.slice(0, -(customDomain.length + 1));
    request.uri = '/' + appName + request.uri;
  }
  return request;
}`;
}
