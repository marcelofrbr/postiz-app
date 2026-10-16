import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Robô MultiPost' : 'Gitroom'} Plugs`,
  description: '',
};
export default async function Index() {
  return redirect('/settings?tab=plugs');
}
