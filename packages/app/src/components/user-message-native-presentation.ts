import { createContext } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { NativeMessageMode, NativeMessagePresentation } from "./user-message-flow-model";

/** Opt-in input from the Android sticky owner. Other platforms keep their renderer. */
export interface NativeMessagePresentationDriver {
  binding: number;
  activeBinding: SharedValue<number>;
  handoff: SharedValue<boolean>;
  presentation: SharedValue<NativeMessagePresentation>;
  maximumHeight: SharedValue<number>;
  wrapperHeight: SharedValue<number>;
  expanded: SharedValue<boolean>;
  onExpandedChange(expanded: boolean): void;
}

export const NativeMessagePresentationContext =
  createContext<NativeMessagePresentationDriver | null>(null);

/** React receives only a discrete authority token, never presentation ownership. */
export const NativeMessageDisclosureAuthorityContext = createContext({ revision: 0, cycle: 0 });

export interface NativeMessageDisclosureRequest {
  revision: number;
  cycle: number;
  expected: NativeMessageMode;
  expanded: boolean;
}
