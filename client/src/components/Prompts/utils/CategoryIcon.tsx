import React from 'react';
import {
  Dices,
  BoxIcon,
  FileText,
  PenLineIcon,
  LightbulbIcon,
  LineChartIcon,
  ShoppingBagIcon,
  PlaneTakeoffIcon,
  GraduationCapIcon,
  TerminalSquareIcon,
  Users as UsersIcon,
  Beaker as BeakerIcon,
  Settings as SettingsIcon,
} from 'lucide-react';
import { cn } from '~/utils';

const categoryIconMap: Record<string, React.ElementType> = {
  misc: BoxIcon,
  roleplay: Dices,
  write: PenLineIcon,
  idea: LightbulbIcon,
  shop: ShoppingBagIcon,
  finance: LineChartIcon,
  code: TerminalSquareIcon,
  travel: PlaneTakeoffIcon,
  teach_or_explain: GraduationCapIcon,
  general: BoxIcon,
  hr: UsersIcon,
  rd: BeakerIcon,
  it: TerminalSquareIcon,
  sales: LineChartIcon,
  aftersales: SettingsIcon,
};

const categoryColorMap: Record<string, string> = {
  code: 'text-category-icon-5',
  misc: 'text-category-icon-1',
  shop: 'text-category-icon-6',
  idea: 'text-category-icon-4',
  write: 'text-category-icon-6',
  travel: 'text-category-icon-4',
  finance: 'text-category-icon-2',
  roleplay: 'text-category-icon-2',
  teach_or_explain: 'text-category-icon-1',
  general: 'text-category-icon-1',
  hr: 'text-category-icon-7',
  rd: 'text-category-icon-6',
  it: 'text-category-icon-5',
  sales: 'text-category-icon-2',
  aftersales: 'text-category-icon-4',
};

export default function CategoryIcon({
  category,
  className = '',
}: {
  category: string;
  className?: string;
}) {
  const IconComponent = categoryIconMap[category] ?? FileText;
  const colorClass = categoryColorMap[category] ?? 'text-text-secondary';
  return <IconComponent className={cn('size-4', colorClass, className)} aria-hidden="true" />;
}
