/**
 * Native share/save seam for the Anki CSV export (SPEC TASK-075). The CSV
 * text produced by the backend (TASK-074) is written into the app cache
 * directory and handed to the OS share sheet, where the user chooses any
 * "save to files"/cloud/mail target — including direct import into Anki or
 * AnkiDroid. react-native-blob-util provides the filesystem write and
 * react-native-share opens the sheet with a typed file URI; both native
 * modules are mocked in jest.setup.js and screen tests mock this module, so
 * swapping implementations never touches UI code. Dismissing the sheet is a
 * normal outcome (`failOnCancel: false`), not an error.
 */
import ReactNativeBlobUtil from 'react-native-blob-util';
import Share from 'react-native-share';

import {VOCABULARY_EXPORT_FILENAME} from '../api/vocabulary';

/** Write the CSV to cache storage and open the system share/save sheet. */
export async function shareAnkiCsv(csv: string): Promise<void> {
  const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/${VOCABULARY_EXPORT_FILENAME}`;
  await ReactNativeBlobUtil.fs.writeFile(path, csv, 'utf8');
  await Share.open({
    url: `file://${path}`,
    type: 'text/csv',
    filename: VOCABULARY_EXPORT_FILENAME,
    failOnCancel: false,
  });
}
