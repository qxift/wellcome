import { CabinetPanorama } from "@/components/CabinetPanorama";
import { cabinetItems } from "@/data/cabinetItems";

export default function Home() {
  return <CabinetPanorama items={cabinetItems} />;
}
