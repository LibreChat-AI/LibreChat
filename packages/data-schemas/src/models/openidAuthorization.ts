import type { Connection, Model } from 'mongoose';
import type * as t from '~/types';
import openidSubjectSchema from '~/schema/openidSubject';
import openidSessionSchema from '~/schema/openidSession';
import openidBindingSchema from '~/schema/openidBinding';
import openidLogoutSchema from '~/schema/openidLogout';
import logger from '~/config/winston';

export interface OpenIDAuthorizationModels {
  OpenIDSubject: Model<t.IOpenIDSubject>;
  OpenIDSession: Model<t.IOpenIDSession>;
  OpenIDBinding: Model<t.IOpenIDBinding>;
  OpenIDLogout: Model<t.IOpenIDLogout>;
}

/** Registers these models on the caller's dedicated authorization connection, never on the
 *  app's default connection. */
export function createOpenIDAuthorizationModels(connection: Connection): OpenIDAuthorizationModels {
  const models: OpenIDAuthorizationModels = {
    OpenIDSubject:
      (connection.models.OpenIDSubject as Model<t.IOpenIDSubject>) ||
      connection.model<t.IOpenIDSubject>('OpenIDSubject', openidSubjectSchema),
    OpenIDSession:
      (connection.models.OpenIDSession as Model<t.IOpenIDSession>) ||
      connection.model<t.IOpenIDSession>('OpenIDSession', openidSessionSchema),
    OpenIDBinding:
      (connection.models.OpenIDBinding as Model<t.IOpenIDBinding>) ||
      connection.model<t.IOpenIDBinding>('OpenIDBinding', openidBindingSchema),
    OpenIDLogout:
      (connection.models.OpenIDLogout as Model<t.IOpenIDLogout>) ||
      connection.model<t.IOpenIDLogout>('OpenIDLogout', openidLogoutSchema),
  };
  /** Background index builds fail silently unless an 'index' listener is attached. */
  for (const model of Object.values(models)) {
    if (model.listenerCount('index') === 0) {
      model.on('index', (error?: Error) => {
        if (error) {
          logger.error(`Index build failed for "${model.modelName}": ${error.message}`);
        }
      });
    }
  }
  return models;
}
