const FONT_FAMILY =
  'Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

interface PageHeaderProps {
  title: string;
}

export default function PageHeader({ title }: PageHeaderProps) {
  return (
    <div className="w-full">
      <div className="px-6" style={{ paddingTop: '18px' }}>
        <h1
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: '0.875rem',
            fontWeight: 500,
            lineHeight: 1.5,
            color: '#161517',
            margin: 0,
            padding: 0,
          }}
        >
          {title}
        </h1>
      </div>
      <hr
        style={{
          border: 'none',
          borderTop: '1px solid rgba(22,21,23,0.1)',
          marginTop: '16px',
          marginBottom: '24px',
          padding: 0,
          width: '100%',
        }}
      />
    </div>
  );
}
