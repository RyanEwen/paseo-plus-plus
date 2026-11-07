import { useEffect, useState } from "react";
import { openRemoteSshForm, type RemoteSshFormSnapshot } from "./remote-ssh-form-model";

/**
 * Construct once per open form and release secrets on unmount, including native dismissal.
 * The snapshot is read only when the form opens; later prop changes do not rebuild the model.
 */
export function useRemoteSshFormModel(snapshot: RemoteSshFormSnapshot) {
  const [model] = useState(() => openRemoteSshForm(snapshot));
  useEffect(() => () => model.close(), [model]);
  return model;
}
