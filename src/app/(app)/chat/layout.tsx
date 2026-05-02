import '@openuidev/react-ui/components.css';
import '@openuidev/react-ui/defaults.css';
// Workgraph theme overrides — must come after OpenUI defaults to win cascade.
import '@/styles/openui-theme.css';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
