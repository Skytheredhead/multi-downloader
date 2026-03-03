import "../styles/globals.css";
import { Analytics } from "@vercel/analytics/next";
import Head from "next/head";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <link rel="icon" href="/favicon.ico?v=3" sizes="any" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
      </Head>
      <Component {...pageProps} />
      <Analytics />
    </>
  );
}
