import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cluster Intelligence - 安全域拓扑可视化平台',
  description: '基于流量特征的网络拓扑可视化与安全域分析平台',
};

export const viewport: Viewport = {
  themeColor: '#0B1220',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-theme="dark" style={{ colorScheme: 'dark' }}>
      <body className="antialiased" style={{ fontFamily: 'var(--font-sans)' }}>
        {children}
      </body>
    </html>
  );
}
