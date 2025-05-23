// src/adapters/node/request.ts
import * as set_cookie_parser from "set-cookie-parser";
function get_raw_body(req, body_size_limit) {
  const h = req.headers;
  if (!h["content-type"]) return null;
  const content_length = Number(h["content-length"]);
  if (req.httpVersionMajor === 1 && isNaN(content_length) && h["transfer-encoding"] == null || content_length === 0) {
    return null;
  }
  let length = content_length;
  if (body_size_limit) {
    if (!length) {
      length = body_size_limit;
    } else if (length > body_size_limit) {
      throw Error(
        `Received content-length of ${length}, but only accept up to ${body_size_limit} bytes.`
      );
    }
  }
  if (req.destroyed) {
    const readable = new ReadableStream();
    readable.cancel();
    return readable;
  }
  let size = 0;
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      req.on("error", (error) => {
        cancelled = true;
        controller.error(error);
      });
      req.on("end", () => {
        if (cancelled) return;
        controller.close();
      });
      req.on("data", (chunk) => {
        if (cancelled) return;
        size += chunk.length;
        if (size > length) {
          cancelled = true;
          controller.error(
            new Error(
              `request body size exceeded ${content_length ? "'content-length'" : "BODY_SIZE_LIMIT"} of ${length}`
            )
          );
          return;
        }
        controller.enqueue(chunk);
        if (controller.desiredSize === null || controller.desiredSize <= 0) {
          req.pause();
        }
      });
    },
    pull() {
      req.resume();
    },
    cancel(reason) {
      cancelled = true;
      req.destroy(reason);
    }
  });
}
function getRequest({
  request,
  base,
  bodySizeLimit
}) {
  return new Request(base + request.url, {
    // @ts-expect-error
    duplex: "half",
    method: request.method,
    body: get_raw_body(request, bodySizeLimit),
    headers: request.headers
  });
}
async function setResponse(res, response) {
  for (const [key, value] of response.headers) {
    try {
      res.setHeader(
        key,
        key === "set-cookie" ? set_cookie_parser.splitCookiesString(response.headers.get(key)) : value
      );
    } catch (error) {
      res.getHeaderNames().forEach((name) => res.removeHeader(name));
      res.writeHead(500).end(String(error));
      return;
    }
  }
  res.writeHead(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  if (response.body.locked) {
    res.end(
      "Fatal error: Response body is locked. This can happen when the response was already read (for example through 'response.json()' or 'response.text()')."
    );
    return;
  }
  const reader = response.body.getReader();
  if (res.destroyed) {
    reader.cancel();
    return;
  }
  const cancel = (error) => {
    res.off("close", cancel);
    res.off("error", cancel);
    reader.cancel(error).catch(() => {
    });
    if (error) res.destroy(error);
  };
  res.on("close", cancel);
  res.on("error", cancel);
  next();
  async function next() {
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          res.once("drain", next);
          return;
        }
      }
      res.end();
    } catch (error) {
      cancel(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// src/adapters/node/index.ts
function toNodeHandler(handler) {
  return async (req, res) => {
    const protocol = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
    const base = `${protocol}://${req.headers[":authority"] || req.headers.host}`;
    const response = await handler(getRequest({ base, request: req }));
    return setResponse(res, response);
  };
}
export {
  getRequest,
  setResponse,
  toNodeHandler
};
//# sourceMappingURL=node.js.map