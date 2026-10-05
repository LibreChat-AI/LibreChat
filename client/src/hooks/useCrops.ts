import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

export interface Crop {
  _id: string;
  name: string;
  imageUrl?: string | null;
}

interface CropsResponse {
  crops: Crop[];
  totalCount: number;
  totalPages: number;
}

const fetchCropsForClient = async (): Promise<Crop[]> => {
  const { data } = await axios.get<CropsResponse>('http://localhost:3090/api/crops');
  return (data.crops ?? []).slice(2);
};

export const useCropsClient = () => {
  return useQuery({
    queryKey: ['crops', 'client'],
    queryFn: fetchCropsForClient,
    staleTime: 5 * 60 * 1000,
  });
};
