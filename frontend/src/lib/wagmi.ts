import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia } from "wagmi/chains";

export const wagmiConfig = getDefaultConfig({
  appName: "IRL Quest Engine",
  projectId: "demo",
  chains: [baseSepolia],
  ssr: true,
});
