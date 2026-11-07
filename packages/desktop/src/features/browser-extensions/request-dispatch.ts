/** Who called an extension API: a frame (page, popup or extension document) or the extension's service worker. */
export type ExtensionCaller = { kind: "frame"; webContentsId: number } | { kind: "worker" };

/** One validated extension API call, ready for its namespace handler. */
export interface ExtensionApiRequest<TExtension> {
  /** Full API name, such as `tabs.query`. */
  method: string;
  args: unknown[];
  caller: ExtensionCaller;
  extension: TExtension;
}

/** Handles every method of one API namespace; throws `unsupportedExtensionApi` for the rest. */
export type ExtensionApiHandler<TExtension> = (request: ExtensionApiRequest<TExtension>) => unknown;

/** The error for an API Paseo does not implement. */
export function unsupportedExtensionApi(method: string): Error {
  return new Error(`Extension API ${method} is not supported in Paseo.`);
}

/**
 * Route a call to the handler for its namespace, the part of `method` before the first dot.
 * A method without a namespace, or with an unknown one, is unsupported.
 */
export function dispatchExtensionApiRequest<TExtension>(
  handlers: Readonly<Record<string, ExtensionApiHandler<TExtension>>>,
  request: ExtensionApiRequest<TExtension>,
): unknown {
  const separator = request.method.indexOf(".");
  if (separator <= 0) {
    throw unsupportedExtensionApi(request.method);
  }
  const namespace = request.method.slice(0, separator);
  if (!Object.hasOwn(handlers, namespace)) {
    throw unsupportedExtensionApi(request.method);
  }
  return handlers[namespace](request);
}
