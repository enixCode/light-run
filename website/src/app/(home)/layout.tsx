// The home route is a full-bleed bespoke landing with its own header and
// footer, so it deliberately does not use Fumadocs' HomeLayout chrome.
export default function Layout({ children }: LayoutProps<'/'>) {
  return <>{children}</>;
}
