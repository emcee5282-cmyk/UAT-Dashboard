import type { Metadata } from "next";
import { Geist_Mono, Outfit } from "next/font/google";
import "./globals.css";
import Sidebar from "./components/Sidebar";
import { ThemeProvider } from "./components/ThemeProvider";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Operations Overview",
  description: "AFKenta Solution",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className={`${outfit.variable} font-sans flex min-h-screen overflow-x-auto overflow-y-hidden bg-[#f5f5f7] text-[#1a1a1a] transition-colors duration-300 dark:bg-[#1c1c1e] dark:text-white`}>
        <ThemeProvider>
          <Sidebar />
          <main className="h-screen flex-1 overflow-y-auto">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}