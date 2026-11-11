import { z } from "zod";
import type {
  EncodedVideoChunk as PluginEncodedVideoChunk,
  EncodedVideoConfig,
} from "@getpaseo/plugin/client/ui";

/**
 * Message contract between the Android host and the private canvas document.
 *
 * Every host message carries the host's bridge generation. The canvas echoes it on
 * everything it sends back, so the host can drop output that belongs to a decoder it
 * has already replaced, reset or unmounted.
 */
export type HostToCanvasMessage =
  | { type: "configure"; generation: number; config: EncodedVideoConfig }
  | { type: "decode"; generation: number; chunk: PluginEncodedVideoChunk }
  | { type: "present"; generation: number; frameId: number; requestId: number }
  | { type: "release"; generation: number; frameId: number }
  | { type: "reset"; generation: number };

type WithoutGeneration<Message> = Message extends unknown ? Omit<Message, "generation"> : never;

/** A host message before the bridge stamps it with the current generation. */
export type HostToCanvasCommand = WithoutGeneration<HostToCanvasMessage>;

const frameSchema = z.object({
  id: z.number().int(),
  timestamp: z.number(),
  displayWidth: z.number().positive(),
  displayHeight: z.number().positive(),
});

const canvasToHostMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("error"), message: z.string(), generation: z.number().int() }),
  z.object({ type: z.literal("dequeue"), generation: z.number().int() }),
  z.object({ type: z.literal("frame"), generation: z.number().int(), frame: frameSchema }),
  z.object({
    type: z.literal("presented"),
    generation: z.number().int(),
    requestId: z.number().int(),
  }),
]);

export type CanvasToHostMessage = z.infer<typeof canvasToHostMessageSchema>;

/**
 * Parse one message posted by the canvas document.
 *
 * @param data - The raw string from the WebView message event.
 * @returns The typed message, or null when the payload is not JSON or not a known shape.
 */
export function parseCanvasToHostMessage(data: string): CanvasToHostMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const result = canvasToHostMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}
