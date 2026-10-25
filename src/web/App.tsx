import { useState } from 'react';
import { FileList } from './components/FileList';
import { AllFilesDiff } from './components/HunkList';
import { Header } from './components/Header';
import { Layout } from './components/Layout';
import { SubmitModal } from './components/SubmitModal';
import { ReviewProvider, useReview } from './state';

function Review() {
  const { files, threadsError } = useReview();
  const [submitting, setSubmitting] = useState(false);
  return (
    <>
      <Layout
        header={<Header onSubmit={() => setSubmitting(true)} />}
        rail={<FileList files={files} />}
        main={
          <>
            {threadsError && (
              <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Existing review threads could not be loaded: {threadsError}
              </p>
            )}
            <AllFilesDiff />
          </>
        }
      />
      {submitting && <SubmitModal onClose={() => setSubmitting(false)} />}
    </>
  );
}

export function App() {
  return (
    <ReviewProvider>
      <Review />
    </ReviewProvider>
  );
}
