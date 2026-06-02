import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata = {
  metadataBase: new URL('https://enixcode.github.io/light-run'),
  title: {
    default: 'light-run',
    template: '%s | light-run',
  },
  description: 'A thin HTTP server around the light-runner SDK: POST code, run it in a Docker container, fetch artifacts.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
