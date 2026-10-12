import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { docDataService } from '../services/docDataService'

export type DocBackendType = 'control-plane' | 'content-runtime'

export interface DocDataConfig {
  /** Backend type - determines API endpoints */
  backend: DocBackendType
  /** Base URL for API calls */
  baseUrl: string
  /** Organization ID (for control-plane) */
  organizationId?: string
  /** Documentation ID */
  documentationId?: string
  /** Version ID */
  versionId?: string
  /** Auth token getter */
  getAuthToken?: () => Promise<string | null>
  /** Whether editing is enabled */
  editingEnabled?: boolean
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Dev domain for X-Dev-Domain header (content-runtime dev mode) */
  devDomain?: string
}

export interface DocDataContextValue extends DocDataConfig {
  /** Build full API URL for a path */
  buildUrl: (module:string,path: string) => string
  /** Check if we're in dashboard mode (control-plane) */
  isDashboard: boolean
  /** Check if we're in production mode (content-runtime) */
  isProduction: boolean
}

const DocDataContext = createContext<DocDataContextValue | null>(null)

export interface DocDataProviderProps {
  children: ReactNode
  config: DocDataConfig
}

/**
 * DocDataProvider - Provides configuration for documentation data fetching.
 *
 * This provider configures how documentation components fetch and save data.
 * It supports two backends:
 * - control-plane: Used by dashboard for editing documentation
 * - content-runtime: Used by production frontend for serving documentation
 *
 * @example
 * ```tsx
 * // Dashboard usage
 * <DocDataProvider config={{
 *   backend: 'control-plane',
 *   baseUrl: 'https://docs.example.com',
 *   organizationId: 'org-123',
 *   documentationId: 'doc-456',
 *   versionId: 'v1',
 *   editingEnabled: true,
 *   getAuthToken: () => getAccessToken(),
 * }}>
 *   <DocContentViewer editable />
 * </DocDataProvider>
 *
 * // Production frontend usage
 * <DocDataProvider config={{
 *   backend: 'content-runtime',
 *   baseUrl: 'https://docs.example.com/api',
 *   documentationId: 'my-docs',
 *   editingEnabled: false,
 * }}>
 *   <DocContentViewer />
 * </DocDataProvider>
 * ```
 */
export function DocDataProvider({ children, config }: DocDataProviderProps) {
  const value = useMemo<DocDataContextValue>(() => {
    return docDataService.setConfig(config)
  }, [config])

  return (
    <DocDataContext.Provider value={value}>
      {children}
    </DocDataContext.Provider>
  )
}

/**
 * Hook to access documentation data configuration.
 */
export function useDocData(): DocDataContextValue {
  const context = useContext(DocDataContext)
  const globalContext = docDataService.getContextValue()

  const finalContext = context || globalContext

  if (!finalContext) {
    throw new Error('useDocData must be used within a DocDataProvider or initialized via docDataService')
  }
  return finalContext
}

/**
 * Hook to check if we're in a DocDataProvider context.
 * Returns null if not in context (useful for optional provider usage).
 * Fallbacks to global docDataService if React Context is lost.
 */
export function useDocDataOptional(): DocDataContextValue | null {
  const context = useContext(DocDataContext)
  return context || docDataService.getContextValue()
}
