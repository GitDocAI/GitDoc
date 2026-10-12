import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import * as solidIcons from '@heroicons/react/24/solid'
import * as outlineIcons from '@heroicons/react/24/outline'
import { allIcons, type Icon, type IconLibrary } from '../editor/node-views/icon-data'
import { Icon as LegacyIcon } from '../Icon'

interface IconPickerProps {
  selectedIcon: string;
  onSelectIcon: (iconKey: string) => void;
  onRemoveIcon: () => void;
  showPicker: boolean;
  onClosePicker: () => void;
  pickerPosition: { top: number; left: number };
  theme: 'light' | 'dark';
  iconColor: string;
}

// Helper to render icons from different libraries
export const IconRenderer = ({ iconKey, style, ...props }: { iconKey: string; style?: React.CSSProperties; [key: string]: any }) => {
  if (!iconKey) return null

  // Extract size from style for consistent sizing
  const size = style?.width || style?.height || style?.fontSize
  const iconStyle: React.CSSProperties = {
    ...style,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  // Handle new icon library formats
  if (iconKey.startsWith('pi ')) {
    return <i className={iconKey} style={iconStyle} {...props}></i>
  }
  if (iconKey.startsWith('fa ')) {
    return <i className={iconKey} style={iconStyle} {...props}></i>
  }
  if (iconKey.startsWith('mi-')) {
    const iconName = iconKey.substring(3)
    return <span className="material-icons" style={iconStyle} {...props}>{iconName}</span>
  }
  if (iconKey.startsWith('hi-')) {
    const keyParts = iconKey.substring(3).split('-')
    const type = keyParts.pop()
    const name = keyParts.join('-')

    const componentName = name.charAt(0).toUpperCase() + name.slice(1) + 'Icon'

    const iconLib = type === 'solid' ? solidIcons : outlineIcons
    const IconComponent = (iconLib as any)[componentName]

    if (IconComponent) {
      // For Heroicons (SVG), use width/height directly
      const svgStyle: React.CSSProperties = {
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        maxWidth: size,
        maxHeight: size,
        color: style?.color,
      }
      return <IconComponent style={svgStyle} {...props} />
    }
  }

  // Fallback: Use legacy Icon component for simple names (book-open, code, etc.)
  // This maintains backward compatibility with existing section icons
  const numericSize = typeof size === 'number' ? size : parseInt(size as string, 10) || 16
  return <LegacyIcon name={iconKey} size={numericSize} style={{ color: style?.color }} {...props} />
}

// Helper to get the library name
const getLibraryName = (library: IconLibrary) => {
  switch (library) {
    case 'fa': return 'Font Awesome'
    case 'hi-outline': return 'Heroicons (Outline)'
    case 'hi-solid': return 'Heroicons (Solid)'
    case 'mi': return 'Material Icons'
    case 'pi': return 'Prime Icons'
  }
}

export const IconPicker = ({
  selectedIcon,
  onSelectIcon,
  onRemoveIcon,
  showPicker,
  onClosePicker,
  pickerPosition,
  theme,
  iconColor,
}: IconPickerProps) => {
  const inlineIconPickerRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [adjustedPosition, setAdjustedPosition] = useState<{ top: number; left: number } | null>(null)

  const filteredIcons = searchQuery
    ? allIcons.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()) || i.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase())))
    : allIcons

  // Adjust position to fit within viewport
  useEffect(() => {
    if (showPicker) {
      // Small delay to allow the picker to render and get its dimensions
      const adjustPosition = () => {
        if (!inlineIconPickerRef.current) return

        const picker = inlineIconPickerRef.current
        const rect = picker.getBoundingClientRect()
        const viewportHeight = window.innerHeight
        const viewportWidth = window.innerWidth
        const pickerHeight = rect.height || 500
        const pickerWidth = rect.width || 400

        // Convert absolute position to fixed (relative to viewport)
        let newTop = pickerPosition.top - window.scrollY
        let newLeft = pickerPosition.left - window.scrollX

        // Check if picker goes beyond bottom of viewport
        if (newTop + pickerHeight > viewportHeight - 16) {
          newTop = viewportHeight - pickerHeight - 16
        }

        // Make sure it doesn't go above the viewport
        if (newTop < 16) {
          newTop = 16
        }

        // Check if picker goes beyond right edge
        if (newLeft + pickerWidth > viewportWidth - 16) {
          newLeft = viewportWidth - pickerWidth - 16
        }

        // Check if picker goes beyond left edge
        if (newLeft < 16) {
          newLeft = 16
        }

        setAdjustedPosition({ top: newTop, left: newLeft })
      }

      // Run immediately and after a short delay for accurate dimensions
      adjustPosition()
      const timeoutId = setTimeout(adjustPosition, 50)

      return () => clearTimeout(timeoutId)
    }
  }, [showPicker, pickerPosition])

  // Close inline icon picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (inlineIconPickerRef.current && !inlineIconPickerRef.current.contains(event.target as Node)) {
        onClosePicker()
        setSearchQuery('')
        setAdjustedPosition(null)
      }
    }
    if (showPicker) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showPicker, onClosePicker])

  const handleSelectIcon = (iconKey: string) => {
    onSelectIcon(iconKey)
    setSearchQuery('')
    setAdjustedPosition(null)
  }

  const groupedIcons = filteredIcons.reduce((acc, icon) => {
    if (!acc[icon.library]) {
      acc[icon.library] = []
    }
    acc[icon.library].push(icon)
    return acc
  }, {} as Record<IconLibrary, Icon[]>)

  if (!showPicker) return null

  const isLight = theme === 'light'
  // Linear-style palette — tight borders, solid bg, quiet hover.
  const pk = isLight
    ? {
        bg: '#ffffff',
        border: '#e4e4e7',
        divider: '#f4f4f5',
        label: '#71717a',
        title: '#09090b',
        text: '#27272a',
        inputBg: '#fafafa',
        inputBorder: '#e4e4e7',
        inputPlaceholder: '#a1a1aa',
        btnHover: '#f4f4f5',
        tileBg: '#fafafa',
        tileBorder: '#e4e4e7',
        tileHover: '#f4f4f5',
        tileBorderHover: '#d4d4d8',
        shadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
      }
    : {
        bg: '#0a0a0a',
        border: '#27272a',
        divider: '#1f1f22',
        label: '#71717a',
        title: '#fafafa',
        text: '#e4e4e7',
        inputBg: '#18181b',
        inputBorder: '#27272a',
        inputPlaceholder: '#52525b',
        btnHover: '#18181b',
        tileBg: '#18181b',
        tileBorder: '#27272a',
        tileHover: '#1f1f22',
        tileBorderHover: '#3f3f46',
        shadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
      }

  // Use fixed positioning when we have adjusted position (viewport-relative)
  // Use absolute positioning when using original pickerPosition (document-relative)
  const useFixedPosition = adjustedPosition !== null
  const finalPosition = adjustedPosition || {
    top: pickerPosition.top,
    left: pickerPosition.left
  }

  return createPortal(
    <div
      ref={inlineIconPickerRef}
      style={{
        position: useFixedPosition ? 'fixed' : 'absolute',
        top: finalPosition.top,
        left: finalPosition.left,
        zIndex: 10000,
        backgroundColor: pk.bg,
        border: `1px solid ${pk.border}`,
        borderRadius: 'var(--radius-xl)',
        padding: '14px',
        boxShadow: pk.shadow,
        width: '400px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: '12px',
        borderBottom: `1px solid ${pk.divider}`,
      }}>
        <span style={{
          fontSize: '13px',
          fontWeight: '600',
          color: pk.title,
        }}>
          Select Icon
        </span>
        <button
          type="button"
          onClick={onClosePicker}
          style={{
            padding: '4px',
            backgroundColor: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            color: pk.label,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = pk.btnHover
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
        >
          <i className="pi pi-times" style={{ fontSize: '14px' }}></i>
        </button>
      </div>

      {/* Search input */}
      <div style={{ position: 'relative' }}>
        <i className="pi pi-search" style={{
          position: 'absolute',
          left: '12px',
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: '14px',
          color: pk.inputPlaceholder,
        }}></i>
        <input
          type="text"
          placeholder="Search icons..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            padding: '10px 12px 10px 36px',
            border: `1px solid ${pk.border}`,
            borderRadius: 'var(--radius-lg)',
            backgroundColor: pk.inputBg,
            color: pk.title,
            fontSize: '13px',
            boxSizing: 'border-box',
            outline: 'none',
            transition: 'all 0.15s',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = iconColor
            e.currentTarget.style.boxShadow = `0 0 0 3px ${iconColor}20`
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = pk.inputBorder
            e.currentTarget.style.boxShadow = 'none'
          }}
        />
      </div>

      {/* Remove icon button */}
      {selectedIcon && (
        <button
          type="button"
          onClick={() => {
            onRemoveIcon()
            onClosePicker()
          }}
          style={{
            width: '100%',
            padding: '10px',
            backgroundColor: isLight ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.12)',
            border: `1px solid ${isLight ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.25)'}`,
            borderRadius: 'var(--radius-lg)',
            color: '#ef4444',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = isLight ? 'rgba(239, 68, 68, 0.12)' : 'rgba(239, 68, 68, 0.18)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = isLight ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.12)'
          }}
        >
          <i className="pi pi-trash" style={{ fontSize: '12px' }}></i>
          Remove Icon
        </button>
      )}

      {/* Icons grid */}
      <div style={{
        maxHeight: '320px',
        overflowY: 'auto',
        paddingRight: '4px',
        marginRight: '-4px',
      }}>
        {Object.entries(groupedIcons).map(([library, icons]) => (
          <div key={library} style={{ marginBottom: '16px' }}>
            <h4 style={{
              margin: '0 0 8px 0',
              fontSize: '11px',
              fontWeight: '600',
              color: pk.label,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              {getLibraryName(library as IconLibrary)}
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {(icons as Icon[]).map(({ key, name }) => {
                const isSelected = selectedIcon === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSelectIcon(key)}
                    style={{
                      padding: '8px',
                      backgroundColor: isSelected
                        ? iconColor
                        : pk.tileBg,
                      border: isSelected
                        ? `2px solid ${iconColor}`
                        : `1px solid ${pk.tileBorder}`,
                      borderRadius: 'var(--radius-lg)',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      width: '42px',
                      height: '42px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.backgroundColor = pk.tileHover
                        e.currentTarget.style.borderColor = pk.tileBorderHover
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.backgroundColor = pk.tileBg
                        e.currentTarget.style.borderColor = pk.tileBorder
                      }
                    }}
                    title={name}
                  >
                    <IconRenderer iconKey={key} style={{
                      fontSize: '18px',
                      color: isSelected ? '#ffffff' : (pk.text),
                      width: '20px',
                      height: '20px'
                    }} />
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        {filteredIcons.length === 0 && (
          <div style={{
            textAlign: 'center',
            color: pk.inputPlaceholder,
            padding: '32px 20px',
            fontSize: '13px',
          }}>
            <i className="pi pi-search" style={{ fontSize: '24px', marginBottom: '8px', display: 'block', opacity: 0.5 }}></i>
            No icons found
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
