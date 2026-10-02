// Container Component
const Container = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-[20px] grow flex-col items-start gap-4">{children}</div>
);

export default Container;
