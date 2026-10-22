import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.File;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;
import org.pokemmo.db.jooq.tables.records.PokemonRecord;
import org.pokemmo.gameserver.game.item.ItemData;
import org.pokemmo.gameserver.game.item.ItemDataReader;
import org.pokemmo.gameserver.game.move.MoveManager;
import org.pokemmo.gameserver.game.pokemon.PokemonData;
import org.pokemmo.gameserver.game.pokemon.PokemonManager;
import org.pokemmo.gameserver.util.SnowflakeIdGenerator;

/** Read-only resource access and native Pokemon creation. Never opens a database.
 * GAME provides species/move/HP/experience/IVs; GM Python owns atomic mail persistence.
 */
public final class GmNativeGrant {
    private GmNativeGrant() { }
    private static final Gson GSON = new Gson();

    public static void main(String[] args) throws Exception {
        if (args.length == 2 && "item-limits".equals(args[0])) {
            Map<Integer, Integer> data = new LinkedHashMap<>();
            for (ItemData item : new ItemDataReader(new File(args[1])).readItemData()) {
                int code = Short.toUnsignedInt(item.getItemIndexId());
                int max = item.getItemMaxStackSize();
                if (code > 0 && max > 0) data.put(code, max);
            }
            if (data.size() < 200) throw new IllegalStateException("Incomplete native Item.bin");
            System.out.println(GSON.toJson(data));
            return;
        }
        if (args.length != 10 || !"pokemon".equals(args[0]))
            throw new IllegalArgumentException("Expected pokemon resourceRoot ownerId ownerName species level objectId mailContainer region catchAddress");
        Path resource = Path.of(args[1]).toAbsolutePath().normalize();
        long owner = Long.parseLong(args[2]);
        String ownerName = args[3];
        int species = Integer.parseInt(args[4]);
        int level = Integer.parseInt(args[5]);
        long objectId = Long.parseLong(args[6]);
        int mailContainer = Integer.parseInt(args[7]);
        int region = Integer.parseInt(args[8]);
        int address = Integer.parseInt(args[9]);
        if (owner <= 0 || ownerName.isBlank() || ownerName.length() > 32
                || species < 1 || species > 32767 || level < 1 || level > 100
                || objectId <= 0 || mailContainer <= 0 || mailContainer > 127
                || region < 0 || region > 127 || address < 0 || address > 32767)
            throw new IllegalArgumentException("Invalid native Pokemon parameters");
        new PokemonManager(resource.resolve("pokemon/Pokemon.jsonc").toString(),
                           resource.resolve("pokemon").toString());
        new MoveManager(resource.resolve("move/Move.bin").toString(),
                        resource.resolve("move").toString());
        Random random = new SecureRandom();
        PokemonData pokemon = PokemonManager.createWildPokemon(
                owner, ownerName, (short) region, (short) address, (short) species,
                (short) level, mailContainer, (short) 0, random,
                new SnowflakeIdGenerator(1, 1));
        if (pokemon == null)
            throw new IllegalArgumentException("Species unavailable in live GAME resource");
        pokemon.setPokemonId(objectId);
        pokemon.setContainerId(mailContainer);
        pokemon.setContainerPosition((short) 0);
        pokemon.setTrainerId(owner);
        pokemon.setOriginalTrainerId(owner);
        pokemon.setOtName(ownerName);
        PokemonRecord rec = pokemon.toPokemonRecord();
        JsonObject out = new JsonObject();
        out.addProperty("id", rec.getId());
        out.addProperty("trainer_id", rec.getTrainerId());
        out.addProperty("container_id", rec.getContainerId());
        out.addProperty("container_position", rec.getContainerPosition());
        out.addProperty("dex_id", rec.getDexId());
        out.addProperty("personality_value", rec.getPersonalityValue());
        out.addProperty("original_trainer_id", rec.getOriginalTrainerId());
        out.addProperty("ot_name", rec.getOtName());
        out.addProperty("name", rec.getName());
        out.addProperty("level_value", rec.getLevelValue());
        out.addProperty("current_hp", rec.getCurrentHp());
        out.addProperty("exp", rec.getExp());
        out.add("moves", GSON.toJsonTree(rec.getMoves()));
        out.add("moves_pp", GSON.toJsonTree(rec.getMovesPp()));
        out.add("can_remember_moves", GSON.toJsonTree(rec.getCanRememberMoves()));
        out.add("ev_values", GSON.toJsonTree(rec.getEvValues()));
        out.add("iv_values", GSON.toJsonTree(rec.getIvValues()));
        out.addProperty("ability", rec.getAbility());
        out.addProperty("ball_type", rec.getBallType());
        out.addProperty("catch_level", rec.getCatchLevel());
        out.addProperty("catch_region", rec.getCatchRegion());
        out.addProperty("catch_address", rec.getCatchAddress());
        out.addProperty("egg_value", rec.getEggValue());
        out.addProperty("hidden_power_type", rec.getHiddenPowerType());
        out.addProperty("current_select_particle_effect_type", rec.getCurrentSelectParticleEffectType());
        out.addProperty("is_shiny", rec.getIsShiny());
        out.addProperty("is_secret", rec.getIsSecret());
        out.addProperty("is_alpha", rec.getIsAlpha());
        out.add("particle_effects", GSON.toJsonTree(rec.getParticleEffects()));
        System.out.println(out);
    }
}
