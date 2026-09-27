import { APP_NAME } from '@centrate/shared';

export function App(): React.JSX.Element {
  return (
    <main className="p-3">
      <h1 className="text-[13px] font-semibold">{APP_NAME}</h1>
    </main>
  );
}
