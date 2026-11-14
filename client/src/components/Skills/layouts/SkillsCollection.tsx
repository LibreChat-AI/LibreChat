import SkillsSidePanel from '../sidebar/SkillsSidePanel';

export default function SkillsCollection({ visible = true }: { visible?: boolean }) {
  return <SkillsSidePanel visible={visible} className="border-e-0" />;
}
