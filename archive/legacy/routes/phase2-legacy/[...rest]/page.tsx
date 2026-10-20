import { redirect } from 'next/navigation';

export default function Phase2LegacyRedirect({
  params,
}: {
  params: { rest: string[] };
}) {
  const rest = (params?.rest ?? []).join('/');
  redirect(`/data-saver/${rest}`);
}
