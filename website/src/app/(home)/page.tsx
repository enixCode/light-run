import { LandingPage } from 'light-landing-page';
import 'light-landing-page/styles.css';
import { lightRunData } from './data';

export default function HomePage() {
  return <LandingPage data={lightRunData} />;
}
