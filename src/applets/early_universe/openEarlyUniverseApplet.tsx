import { OpenAppletOptions, OpenedApplet } from "../../core/host";
import { EarlyUniverseCanvas } from "./EarlyUniverseCanvas";

export function openEarlyUniverseApplet(options?: OpenAppletOptions): OpenedApplet {
  return {
    id: "early-universe",
    title: "From energy to atoms",
    description:
      "A cinematic early Universe: inflation, reheating, the quark–gluon plasma, confinement, matter–antimatter annihilation, the first nuclei and the first atoms, with presenter keys and video export.",
    close: () => {
      options?.host?.onClose?.();
    },
    render: () => <EarlyUniverseCanvas host={options?.host} />
  };
}
