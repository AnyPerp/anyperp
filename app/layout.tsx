import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnyPerp | Any token. A perp. Today.",
  description:
    "Open long and short markets for any supported Robinhood Chain token — without waiting for a listing. Create freely. Trade when safety checks clear. Unaudited testnet prototype.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://anyperp.fun"),
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/logo/anyperp-logo.svg" }],
  },
  openGraph: {
    title: "AnyPerp",
    description: "Any token. A perp. Today. Isolated markets on Robinhood Chain testnet.",
    type: "website",
    url: "https://anyperp.fun",
    images: [{ url: "/anyperp-hero.svg", width: 1600, height: 900, alt: "AnyPerp isolated market infrastructure" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AnyPerp",
    description: "Permissionless perps. Isolated risk. Robinhood Chain testnet.",
    images: ["/anyperp-hero.svg"],
    site: "@tradeanyperp",
    creator: "@tradeanyperp",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
