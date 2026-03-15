import { Helmet } from "react-helmet-async";

export type SeoMeta = {
  title: string;
  description: string;
  canonicalUrl: string;
  robots?: string;
  ogImageUrl?: string;
  jsonLd?: object | object[];
};

const FALLBACK_SITE_URL = "https://theunfairwheel.uk";

const siteName = "The Unfair Wheel";
const defaultDescription =
  "The Unfair Wheel is a weighted random picker for teams that makes recurring selections feel fairer over time.";
const defaultOgImagePath = "/og-image.svg";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getRuntimeOrigin(): string | null {
  if (typeof window === "undefined" || !window.location.origin) {
    return null;
  }

  return trimTrailingSlash(window.location.origin);
}

export function getSiteUrl(): string {
  const configured = import.meta.env.VITE_SITE_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }

  return getRuntimeOrigin() ?? FALLBACK_SITE_URL;
}

function toAbsoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }

  return `${getSiteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function canonicalUrl(path: string): string {
  return toAbsoluteUrl(path);
}

function withSiteName(title: string): string {
  return `${title} | ${siteName}`;
}

export function buildHomeSeo(): SeoMeta {
  const canonical = canonicalUrl("/");
  const description =
    "Weighted random picker for teams with fairness-based odds, real-time group syncing, participant management, and spin history.";

  return {
    title: withSiteName("Weighted Random Picker for Teams"),
    description,
    canonicalUrl: canonical,
    robots: "index,follow",
    ogImageUrl: toAbsoluteUrl(defaultOgImagePath),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: siteName,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: canonical,
        image: toAbsoluteUrl(defaultOgImagePath),
        description,
        featureList: [
          "Weighted random picker for repeated team rituals",
          "Real-time updates for shared group sessions",
          "Participant management for recurring teams",
          "Spin history for transparency and continuity",
        ],
      },
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: siteName,
        url: canonical,
        description: defaultDescription,
      },
    ],
  };
}

export function buildGroupSeo(groupId: string): SeoMeta {
  const canonical = canonicalUrl(`/groups/${encodeURIComponent(groupId)}`);

  return {
    title: withSiteName("Private Group Wheel"),
    description:
      "Private group wheel for running weighted random selections with real-time participant syncing.",
    canonicalUrl: canonical,
    robots: "noindex,nofollow",
    ogImageUrl: toAbsoluteUrl(defaultOgImagePath),
  };
}

export function buildGroupHistorySeo(groupId: string): SeoMeta {
  const canonical = canonicalUrl(
    `/groups/${encodeURIComponent(groupId)}/history`,
  );

  return {
    title: withSiteName("Private Group Spin History"),
    description:
      "Private spin history view for a shared group wheel session.",
    canonicalUrl: canonical,
    robots: "noindex,nofollow",
    ogImageUrl: toAbsoluteUrl(defaultOgImagePath),
  };
}

type SeoHeadProps = {
  meta: SeoMeta;
};

export function SeoHead({ meta }: SeoHeadProps) {
  const jsonLdItems = Array.isArray(meta.jsonLd)
    ? meta.jsonLd
    : meta.jsonLd
      ? [meta.jsonLd]
      : [];

  return (
    <Helmet prioritizeSeoTags>
      <title>{meta.title}</title>
      <meta name="description" content={meta.description} />
      {meta.robots ? <meta name="robots" content={meta.robots} /> : null}
      <link rel="canonical" href={meta.canonicalUrl} />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:type" content="website" />
      <meta property="og:title" content={meta.title} />
      <meta property="og:description" content={meta.description} />
      <meta property="og:url" content={meta.canonicalUrl} />
      {meta.ogImageUrl ? (
        <meta property="og:image" content={meta.ogImageUrl} />
      ) : null}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={meta.title} />
      <meta name="twitter:description" content={meta.description} />
      {meta.ogImageUrl ? (
        <meta name="twitter:image" content={meta.ogImageUrl} />
      ) : null}
      {jsonLdItems.map((item, index) => (
        <script key={index} type="application/ld+json">
          {JSON.stringify(item)}
        </script>
      ))}
    </Helmet>
  );
}

export const seoDefaults = {
  siteName,
  siteUrl: getSiteUrl,
  defaultDescription,
  defaultOgImagePath,
};
