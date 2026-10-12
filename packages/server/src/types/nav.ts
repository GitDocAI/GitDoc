export type PageType = 'page' | 'folder' | 'api_endpoint'
export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A node of the sidebar tree. */
export interface Page {
  id: string
  title: string
  type?: PageType
  method?: HTTPMethod
  endpoint?: string
  icon?: string
  children?: Page[]
}

/** A page reachable from prev/next navigation. */
export interface NavPage {
  id: string
  title: string
  slug?: string
}
