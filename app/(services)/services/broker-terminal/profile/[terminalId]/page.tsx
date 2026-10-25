'use client';

import { useParams } from 'next/navigation';
import ProfilePage from '@/app/_pages/broker-terminal/profile';

export default function BrokerTerminalProfileRoutePage() {
  const params = useParams<{ terminalId: string }>();
  const terminalId = params?.terminalId ?? 'kotak';
  return <ProfilePage terminalId={terminalId} />;
}