import { type DocDataConfig, type DocDataContextValue } from '../components/DocDataProvider'

class DocDataService {
  private contextValue: DocDataContextValue | null = null

  constructor() {
    // The module is evaluated even when consumers (render-cli SSG, server-side
    // bundles) never call into the service, so `import.meta.env` may be
    // undefined here. Optional chaining keeps Node from crashing at import.
    const baseUrl =
      (import.meta as { env?: { VITE_BACKEND_URL?: string } }).env?.VITE_BACKEND_URL ||
      'http://localhost:8080/api'

    this.setConfig({
      backend: 'content-runtime',
      baseUrl: baseUrl,
    });
  }

  /**
   * Initialize the global configuration
   */
  setConfig(config: DocDataConfig): DocDataContextValue {
    const isDashboard = config.backend === 'control-plane'
    const isProduction = config.backend === 'content-runtime'

    const buildUrl = (module:string,path: string): string => {
      const base = config.baseUrl.replace(/\/$/, '')
      if (isDashboard) {
        // Module is usually 'content' or 'assets'
        const parts = [base, module]
        if (config.organizationId) parts.push(config.organizationId)
        if (config.documentationId) parts.push(config.documentationId)
        // Note: versionId might be needed too in the future
        parts.push(path.replace(/^\//, ''))
        return parts.join('/')
      } else {
        // Content runtime uses /api/v1/ prefix by convention
        return `${base}/api/v1/${path.replace(/^\//, '')}`
      }
    }

    this.contextValue = {
      ...config,
      buildUrl,
      isDashboard,
      isProduction,
    }

    // Also store in window for extreme cases of double-instantiation in monorepos
    if (typeof window !== 'undefined') {
      (window as any).__GITDOC_DATA_CONTEXT = this.contextValue
    }

    return this.contextValue
  }

  /**
   * Get the current context value
   */
  getContextValue(): DocDataContextValue | null {
    if (this.contextValue) return this.contextValue

    // Fallback to window storage if local variable is lost (monorepo issue)
    if (typeof window !== 'undefined' && (window as any).__GITDOC_DATA_CONTEXT) {
      return (window as any).__GITDOC_DATA_CONTEXT
    }

    return null
  }

  /**
   * Get the current auth token dynamically
   */
  async getAuthToken(): Promise<string | null> {
    const context = this.getContextValue()
    if (context?.getAuthToken) {
      return await context.getAuthToken()
    }
    
    // Legacy fallback to localStorage
    if (typeof window !== 'undefined') {
      return localStorage.getItem('accessToken')
    }
    
    return null
  }
}

export const docDataService = new DocDataService()
