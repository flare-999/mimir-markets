import "./globals.css";
import { fontDisplay, fontBody, fontMono } from "@/lib/fonts";
import { WalletProvider } from "@/lib/wallet";
import { XmtpProvider } from "@/lib/xmtp/XmtpProvider";
import { Toaster } from "sonner";
import NextTopLoader from "nextjs-toploader";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`}
    >
      <head>
        {/**
         * Applies the theme before first paint. In a <script> rather than React
         * state because any render-time decision happens after the browser has
         * already painted the default palette — which is a full-page flash on
         * every load for anyone who chose light.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('mimir-theme');" +
              "if(!t)t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';" +
              "if(t==='light')document.documentElement.dataset.theme='light';}catch(e){}})();",
          }}
        />
      </head>
      <body className="overflow-x-hidden">
        <NextTopLoader color="#22D3EE" />
        {/*
          One provider, not a stack of them. The EVM-era tree needed a connector
          config provider and a query client under the wallet context; Stellar
          Wallet Kit keeps its state in module-level signals and needs no provider
          of its own, so WalletProvider is the whole wallet tree.
          The XMTP SDK is dynamically imported inside XmtpProvider, so this layout
          stays free of the SDK and its WASM for pages that never open a chat.
        */}
        <WalletProvider>
          <XmtpProvider>{children}</XmtpProvider>
          <Toaster
            position="bottom-center"
            theme="dark"
            toastOptions={{
              // Themed tokens rather than fixed hex: a near-black toast on the
              // light palette read as a rendering bug.
              style: {
                background: "rgb(var(--pv-surface))",
                border: "1px solid rgb(var(--pv-ink) / 0.14)",
                color: "rgb(var(--pv-text))",
                borderRadius: 16,
                fontFamily: "var(--font-body)",
              },
            }}
          />
        </WalletProvider>
      </body>
    </html>
  );
}
