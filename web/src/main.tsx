import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/big-shoulders/opsz.css";
import "@rainbow-me/rainbowkit/styles.css";
import "./index.css";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { rainbowTheme } from "./lib/theme";
import { wagmiConfig } from "./lib/wagmi";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RainbowKitProvider
            theme={rainbowTheme}
            modalSize="compact"
            appInfo={{ appName: "PushPot" }}
          >
            <App />
          </RainbowKitProvider>
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
