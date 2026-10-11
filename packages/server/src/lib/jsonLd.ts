/**
 * schema.org JSON-LD for a documentation page. Emitted in the page head
 * so Google/Bing (and answer engines) can build rich results.
 *
 * Every page carries the site-level `Organization` + `WebSite` nodes so
 * the brand is always discoverable. Content pages add a `TechArticle`
 * (the page itself) + a `BreadcrumbList` (Home › Section › Page). The
 * homepage / KB landing emits only the site-level nodes.
 *
 * URLs must be absolute — callers pass the request origin + the absolute
 * canonical. Relative asset URLs (logo / og image) are resolved against
 * the origin by the caller.
 */
export interface JsonLdInput {
  origin: string
  canonicalUrl: string
  siteName: string
  description?: string
  pageTitle: string
  imageUrl?: string
  logoUrl?: string
  language?: string
  isHome: boolean
  section?: { name: string; url: string } | null
}

export function buildJsonLd(input: JsonLdInput): object {
  const {
    origin,
    canonicalUrl,
    siteName,
    description,
    pageTitle,
    imageUrl,
    logoUrl,
    language = 'en',
    isHome,
    section,
  } = input

  const organization = {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: siteName,
    url: `${origin}/`,
    ...(logoUrl ? { logo: logoUrl } : {}),
  }

  const website = {
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    url: `${origin}/`,
    name: siteName,
    ...(description ? { description } : {}),
    inLanguage: language,
    publisher: { '@id': `${origin}/#organization` },
  }

  const graph: object[] = [organization, website]

  if (!isHome) {
    graph.push({
      '@type': 'TechArticle',
      headline: pageTitle,
      ...(description ? { description } : {}),
      url: canonicalUrl,
      mainEntityOfPage: canonicalUrl,
      inLanguage: language,
      ...(imageUrl ? { image: imageUrl } : {}),
      isPartOf: { '@id': `${origin}/#website` },
      publisher: { '@id': `${origin}/#organization` },
    })

    const crumbs: object[] = [
      { '@type': 'ListItem', position: 1, name: siteName, item: `${origin}/` },
    ]
    if (section) {
      crumbs.push({ '@type': 'ListItem', position: 2, name: section.name, item: section.url })
    }
    crumbs.push({
      '@type': 'ListItem',
      position: section ? 3 : 2,
      name: pageTitle,
      item: canonicalUrl,
    })
    graph.push({ '@type': 'BreadcrumbList', itemListElement: crumbs })
  }

  return { '@context': 'https://schema.org', '@graph': graph }
}
